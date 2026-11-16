import { randomUUID } from 'node:crypto';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { defineSecret, defineString } from 'firebase-functions/params';
import { logger } from 'firebase-functions/v2';
import { type CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { avatarModel, avatarStyle, editImage, expressionPrompt, expressions, isJpeg, portraitPrompt, type Expression } from './avatar-provider';
import { requireActiveAccount } from './account-state';

const apiKey = defineSecret('OPENAI_API_KEY');
const bucketName = defineString('AVATAR_BUCKET', { default: '' });
const options = { region: 'us-central1', maxInstances: 5 };
export const generationOptions = { ...options, secrets: [apiKey], timeoutSeconds: 300, memory: '512MiB' as const };

function uidFor(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use your avatars.');
  return request.auth.uid;
}

function idFor(request: CallableRequest) {
  const id = request.data?.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9]{20}$/.test(id)) {
    throw new HttpsError('invalid-argument', 'Choose an avatar first.');
  }
  return id;
}

function expressionFor(value: unknown): Expression {
  if (typeof value !== 'string' || !Object.hasOwn(expressions, value)) {
    throw new HttpsError('invalid-argument', 'Choose a supported expression.');
  }
  return value as Expression;
}

function profileFor(uid: string) {
  return getFirestore().collection('avatars').doc(uid);
}

export function bucket() {
  if (process.env.FUNCTIONS_EMULATOR === 'true') {
    const project = process.env.GCLOUD_PROJECT;
    if (!process.env.FIREBASE_STORAGE_EMULATOR_HOST || !project) {
      throw new HttpsError('failed-precondition', 'Restart the local app with the Storage emulator enabled.');
    }
    return getStorage().bucket(project + '.appspot.com');
  }
  const configured = bucketName.value().trim();
  if (configured) return getStorage().bucket(configured);
  throw new HttpsError('failed-precondition', 'Private avatar storage needs to be configured.');
}

function prefix(uid: string, id: string) {
  return 'avatars/' + encodeURIComponent(uid) + '/' + id + '/';
}

function fileFor(uid: string, id: string, image: 'portrait' | Expression) {
  return bucket().file(prefix(uid, id) + image + '.jpg');
}

async function save(uid: string, id: string, name: 'portrait' | Expression, image: Buffer) {
  await fileFor(uid, id, name).save(image, {
    resumable: false,
    metadata: { contentType: 'image/jpeg', cacheControl: 'private, no-store' },
  });
}

async function download(uid: string, id: string, name: 'portrait' | Expression) {
  try {
    const [image] = await fileFor(uid, id, name).download();
    return image;
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('unavailable', 'Could not load this avatar image. Check private storage and try again.');
  }
}

async function deleteFiles(uid: string, id: string) {
  try {
    await bucket().deleteFiles({ prefix: prefix(uid, id) });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError('unavailable', 'Could not delete the avatar images. Try again.');
  }
}

async function cleanup(uid: string, id: string) {
  try { await deleteFiles(uid, id); }
  catch { logger.warn('Avatar asset cleanup failed', { versionId: id }); }
}

export function providerKey() {
  const key = apiKey.value()?.trim();
  if (!key) throw new HttpsError('failed-precondition', 'The avatar image provider is not configured. Set the server’s OPENAI_API_KEY and try again.');
  return key;
}

export function requireVerifiedEmail(request: CallableRequest) {
  if (process.env.FUNCTIONS_EMULATOR !== 'true' && request.auth?.token.email_verified !== true) {
    throw new HttpsError('failed-precondition', 'Verify your email in account settings before using AI.');
  }
}

async function withAvatarLock<T>(uid: string, action: (charge: () => Promise<void>) => Promise<T>): Promise<T> {
  const db = getFirestore();
  const ref = db.collection('avatarOperations').doc(uid);
  const token = randomUUID();
  await db.runTransaction(async tx => {
    await requireActiveAccount(uid, tx);
    const active = (await tx.get(ref)).data();
    if (active?.expiresAt > Date.now()) {
      throw new HttpsError('aborted', 'Another avatar operation is in progress. Try again shortly.');
    }
    tx.set(ref, { token, expiresAt: Date.now() + 340_000 }, { merge: true });
  });

  async function charge() {
    await db.runTransaction(async tx => {
      const data = (await tx.get(ref)).data();
      const day = new Date().toISOString().slice(0, 10);
      const count = data?.day === day ? data.count : 0;
      if (count >= 20) throw new HttpsError('resource-exhausted', 'Your daily avatar generation limit has been reached. Try tomorrow.');
      tx.update(ref, { day, count: count + 1 });
    });
  }

  try { return await action(charge); }
  finally {
    await db.runTransaction(async tx => {
      if ((await tx.get(ref)).data()?.token === token) {
        tx.update(ref, { token: FieldValue.delete(), expiresAt: FieldValue.delete() });
      }
    }).catch(() => logger.warn('Avatar operation lock will expire automatically'));
  }
}

export const generateAvatar = onCall(generationOptions, async request => {
  const uid = uidFor(request);
  requireVerifiedEmail(request);
  const { photo, consent } = request.data ?? {};
  if (consent !== true || typeof photo !== 'string' || photo.length > 1_400_000 ||
      !/^\/9j\/[A-Za-z0-9+/]+={0,2}$/.test(photo)) {
    throw new HttpsError('invalid-argument', 'Confirm consent and choose a valid photo.');
  }
  const input = Buffer.from(photo, 'base64');
  if (!isJpeg(input)) throw new HttpsError('invalid-argument', 'Choose a readable photo.');
  const key = providerKey();
  bucket();
  return withAvatarLock(uid, async charge => {
    const profile = profileFor(uid);
    const previous = (await profile.get()).data()?.draft;
    const id = profile.collection('versions').doc().id;
    await charge();
    const image = await editImage(key, uid, input, portraitPrompt);
    try {
      await save(uid, id, 'portrait', image);
      await profile.set({
        draft: { id, provider: 'openai', model: avatarModel, style: avatarStyle, consentAt: FieldValue.serverTimestamp() },
      }, { mergeFields: ['draft'] });
    } catch {
      // Check the committed pointer before removing a staged image after an ambiguous write failure.
      const state = await profile.get().catch(() => null);
      if (state && state.data()?.draft?.id !== id) await cleanup(uid, id);
      throw new HttpsError('unavailable', 'Could not save your generated portrait. Refresh and try again.');
    }
    if (previous?.provider === 'openai' && typeof previous.id === 'string') await cleanup(uid, previous.id);
    return { id };
  });
});

export const selectStarterAvatar = onCall(options, async request => {
  const uid = uidFor(request);
  const starter = request.data?.starter;
  if (typeof starter !== 'string' || !['moon', 'sun', 'comet', 'planet'].includes(starter)) {
    throw new HttpsError('invalid-argument', 'Choose a starter avatar.');
  }
  return withAvatarLock(uid, async () => {
    const profile = profileFor(uid);
    const previous = (await profile.get()).data()?.draft;
    const id = profile.collection('versions').doc().id;
    await profile.set({ draft: { id, provider: 'starter', starter } }, { mergeFields: ['draft'] });
    if (previous?.provider === 'openai') await cleanup(uid, previous.id);
    return { id };
  });
});

export const approveAvatar = onCall(options, async request => {
  const uid = uidFor(request);
  const id = idFor(request);
  const profile = profileFor(uid);
  return withAvatarLock(uid, async () => getFirestore().runTransaction(async tx => {
    const current = (await tx.get(profile)).data();
    if (current?.approvedId === id && (await tx.get(profile.collection('versions').doc(id))).exists) {
      return { id };
    }
    if (current?.draft?.id !== id || !['openai', 'starter'].includes(current.draft.provider)) {
      throw new HttpsError('failed-precondition', 'Choose a new avatar preview before approving.');
    }
    const number = (current.lastVersion ?? 0) + 1;
    tx.create(profile.collection('versions').doc(id), {
      ...current.draft, number, expressions: [], approvedAt: FieldValue.serverTimestamp(),
    });
    tx.update(profile, { approvedId: id, lastVersion: number, draft: FieldValue.delete() });
    return { id };
  }));
});

// A scene service must authorize room membership and likeness consent before using either
// participant's approved version. The version ID always resolves to its original portrait.
export async function loadApprovedReference(ownerUid: string, versionId: string, expression?: Expression) {
  const version = await profileFor(ownerUid).collection('versions').doc(versionId).get();
  if (version.data()?.provider !== 'openai') {
    throw new HttpsError('not-found', 'The approved photo-based avatar is unavailable.');
  }
  if (expression && !version.data()?.expressions?.includes(expression)) {
    throw new HttpsError('failed-precondition', 'The selected expression is unavailable. Choose another before generating.');
  }
  return { version, bytes: await download(ownerUid, versionId, expression ?? 'portrait') };
}

export const generateAvatarExpression = onCall(generationOptions, async request => {
  const uid = uidFor(request);
  requireVerifiedEmail(request);
  const id = idFor(request);
  const expression = expressionFor(request.data?.expression);
  return withAvatarLock(uid, async charge => {
    const ref = profileFor(uid).collection('versions').doc(id);
    const version = (await ref.get()).data();
    if (version?.provider !== 'openai') throw new HttpsError('failed-precondition', 'Approve a photo-based avatar first.');
    if (version.expressions?.includes(expression)) return { expression };

    const key = providerKey();
    const reference = await loadApprovedReference(uid, id);
    await charge();
    const image = await editImage(key, uid, reference.bytes, expressionPrompt(expression));
    try {
      await save(uid, id, expression, image);
      await ref.update({ expressions: FieldValue.arrayUnion(expression) });
    } catch {
      throw new HttpsError('unavailable', 'Could not save this expression. Retry the remaining expressions.');
    }
    return { expression };
  });
});

export const getAvatarImage = onCall(options, async request => {
  const uid = uidFor(request);
  await requireActiveAccount(uid);
  const id = idFor(request);
  const name = request.data?.image === 'portrait' ? 'portrait' : expressionFor(request.data?.image);
  const profile = profileFor(uid);
  const version = (await profile.collection('versions').doc(id).get()).data();
  const draft = name === 'portrait' && !version ? (await profile.get()).data()?.draft : undefined;
  const canRead = version?.provider === 'openai' && (name === 'portrait' || version.expressions?.includes(name));
  if (!canRead && !(draft?.id === id && draft.provider === 'openai')) {
    throw new HttpsError('not-found', 'This avatar image is unavailable.');
  }
  const bytes = await download(uid, id, name);
  return { jpeg: bytes.toString('base64') };
});

export const removeAvatar = onCall(options, async request => {
  const uid = uidFor(request);
  const id = idFor(request);
  return withAvatarLock(uid, async () => {
    const profile = profileFor(uid);
    const version = profile.collection('versions').doc(id);
    const [currentDoc, versionDoc] = await getFirestore().getAll(profile, version);
    const current = currentDoc.data();
    if (current?.draft?.id === id) {
      if (current.draft.provider === 'openai') await deleteFiles(uid, id);
      await profile.update({ draft: FieldValue.delete() });
    } else if (versionDoc.exists) {
      if (versionDoc.data()?.provider === 'openai') await deleteFiles(uid, id);
      const batch = getFirestore().batch();
      batch.delete(version);
      if (current?.approvedId === id) batch.update(profile, { approvedId: FieldValue.delete() });
      await batch.commit();
    }
    return { id };
  });
});
