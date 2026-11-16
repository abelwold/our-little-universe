import { createHash } from 'node:crypto';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { HttpsError, onCall } from 'firebase-functions/v2/https';
import { bucket } from './avatars';
import { joinedRoom, player, validId } from './stories';

const options = { region: 'us-central1', maxInstances: 5, timeoutSeconds: 240 };

export const deleteSharedStory = onCall(options, async request => {
  const uid = player(request);
  const { roomId, storyId } = request.data ?? {};
  if (!validId(storyId)) throw new HttpsError('invalid-argument', 'Choose a story to delete.');
  const db = getFirestore();
  const job = await db.runTransaction(async tx => {
    const { ref, data } = await joinedRoom(tx, roomId, uid);
    const story = ref.collection('stories').doc(storyId);
    const saved = (await tx.get(story)).data();
    if (!saved) return null;
    if ([saved.scene, saved.comic].some(job => job?.status === 'generating' && job.expiresAt > Date.now())) {
      throw new HttpsError('failed-precondition', 'Wait for your artwork to finish before deleting this story.');
    }
    const participants = [data.ownerId, data.partnerId] as string[];
    if (saved.status === 'deleting') return { story, participants };
    tx.set(story, { status: 'deleting' });
    if (data.activeStoryId === storyId) tx.update(ref, { activeStoryId: FieldValue.delete() });
    return { story, participants };
  });
  if (!job) return { deleted: true };
  const { story: storyRef, participants } = job;
  try {
    await bucket().deleteFiles({ prefix: 'rooms/' + roomId + '/scenes/' + storyId + '/' });
    const descendants = await storyRef.parent.where('origin.storyId', '==', storyId).get();
    const writer = db.bulkWriter();
    // A deleted descendant must not be recreated by this cleanup.
    const changes = Promise.allSettled(descendants.docs.map(doc => writer.update(doc.ref, { origin: FieldValue.delete() })));
    await writer.close();
    for (const result of await changes) if (result.status === 'rejected' && result.reason.code !== 5) throw result.reason;
    await eraseNotifications(participants, 'storyId', storyId);
    await storyRef.delete();
    return { deleted: true };
  } catch {
    throw new HttpsError('unavailable', 'Could not finish deleting the story. Try again from the same story link.');
  }
});

async function eraseNotifications(uids: string[], field: 'storyId' | 'roomId', value: string) {
  const db = getFirestore();
  for (const uid of uids) {
    for (;;) {
      const entries = await db.collection('players').doc(uid).collection('notifications')
        .where(field, '==', value).limit(100).get();
      if (entries.empty) break;
      const batch = db.batch();
      for (const entry of entries.docs) batch.delete(entry.ref);
      await batch.commit();
    }
  }
}

export const deleteMyAccount = onCall(options, async request => {
  const uid = player(request);
  const now = Math.floor(Date.now() / 1000);
  if (typeof request.auth?.token.auth_time !== 'number' || request.auth.token.auth_time < now - 300) {
    throw new HttpsError('failed-precondition', 'Confirm your password again to delete your account.');
  }
  const db = getFirestore();
  const member = db.collection('players').doc(uid);
  const marker = db.collection('accountRemovals').doc(uid);
  const avatarOperation = db.collection('avatarOperations').doc(uid);
  const privateBucket = bucket();
  await db.runTransaction(async tx => {
    if ((await tx.get(avatarOperation)).data()?.expiresAt > Date.now()) {
      throw new HttpsError('failed-precondition', 'Wait for your avatar operation to finish and try again.');
    }
    const profile = (await tx.get(member)).data();
    const previous = await tx.get(marker);
    // The marker outlives Auth deletion so a previously issued token cannot recreate data.
    if (!previous.exists) tx.create(marker, { requestedAt: FieldValue.serverTimestamp() });
    if (profile?.inviteCode) {
      tx.delete(db.collection('roomInvitations').doc(createHash('sha256').update(profile.inviteCode).digest('hex')));
    }
  });

  try {
    const rooms = db.collection('rooms');
    for (const field of ['ownerId', 'partnerId']) {
      for (;;) {
        const batch = await rooms.where(field, '==', uid).limit(20).get();
        if (batch.empty) break;
        for (const room of batch.docs) {
          const participants = await db.runTransaction(async tx => {
            const data = (await tx.get(room.ref)).data();
            if (!data) return [];
            const ids = [...new Set([data.ownerId, data.partnerId])].filter((id): id is string => typeof id === 'string');
            const profiles = await Promise.all(ids.map(id => tx.get(db.collection('players').doc(id))));
            for (const profile of profiles) {
              if (profile.data()?.roomId === room.id) tx.update(profile.ref, {
                roomId: null, inviteCode: FieldValue.delete(), inviteExpiresAt: FieldValue.delete(), lastJoinedInvite: FieldValue.delete(),
              });
            }
            tx.update(room.ref, { status: 'ended', activeStoryId: FieldValue.delete() });
            return ids;
          });
          const stories = room.ref.collection('stories');
          // Remove the generating state first. A late provider response then cleans up its own upload.
          await db.recursiveDelete(stories);
          await privateBucket.deleteFiles({ prefix: 'rooms/' + room.id + '/scenes/' });
          await Promise.all(['imageUsage', 'storyDraftUsage'].map(name => db.collection(name).doc(room.id).delete()));
          await eraseNotifications(participants, 'roomId', room.id);
          await db.recursiveDelete(room.ref);
        }
      }
    }
    await privateBucket.deleteFiles({ prefix: 'avatars/' + encodeURIComponent(uid) + '/' });
    await db.recursiveDelete(db.collection('avatars').doc(uid));
    await db.recursiveDelete(member);
    await db.collection('preferences').doc(uid).delete();
    await avatarOperation.delete();
    try { await getAuth().deleteUser(uid); }
    catch (error) { if ((error as { code?: string }).code !== 'auth/user-not-found') throw error; }
    return { deleted: true };
  } catch {
    throw new HttpsError('unavailable', 'Deletion started but could not finish. Sign in again to retry from Account.');
  }
});
