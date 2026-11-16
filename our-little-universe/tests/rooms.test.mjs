import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

const project = 'demo-our-little-universe';
const auth = 'http://127.0.0.1:9098/identitytoolkit.googleapis.com/v1/accounts:';
const functions = 'http://127.0.0.1:5011/' + project + '/us-central1/';
const documents = 'http://127.0.0.1:8088/v1/projects/' + project + '/databases/(default)/documents/';

async function account() {
  const email = randomUUID() + '@example.test';
  const response = await fetch(auth + 'signUp?key=local-demo-key', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({email, password:'local-passphrase', returnSecureToken:true}),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function call(action, data, user) {
  const response = await fetch(functions + action, {
    method: 'POST',
    headers: {'Content-Type':'application/json', ...(user ? {Authorization:'Bearer ' + user.idToken} : {})},
    body: JSON.stringify({data}),
  });
  return {status: response.status, ...(await response.json())};
}

async function doc(path, user, init = {}) {
  const response = await fetch(documents + path, {
    ...init, headers: {...init.headers, Authorization:'Bearer ' + user.idToken},
  });
  return {status: response.status, ...(await response.json())};
}

test('a room admits one authenticated partner and protects private membership', async () => {
  const [host, partner, other] = await Promise.all([account(), account(), account()]);
  const forged = await call('createRoom', {title:'Stars'}, undefined);
  assert.equal(forged.error.status, 'UNAUTHENTICATED');
  const created = await call('createRoom', {title:'Stars'}, host);
  assert.equal(created.status, 200);
  const {roomId} = created.result;
  const playerPath = 'players/' + host.localId;
  const roomPath = 'rooms/' + roomId;
  const firstInvite = (await doc(playerPath, host)).fields.inviteCode.stringValue;
  assert.equal((await doc(roomPath, other)).status, 403);
  assert.equal((await doc(playerPath, other)).status, 403);
  const privateInvitePath = 'roomInvitations/' + createHash('sha256').update(firstInvite).digest('hex');
  assert.equal((await doc(privateInvitePath, host)).status, 403);
  assert.equal((await doc(roomPath, host, {method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{status:{stringValue:'ready'}}})})).status, 403);
  assert.equal((await call('replaceInvite', {}, host)).status, 200);
  assert.equal((await call('joinRoom', {code:firstInvite}, partner)).error.status, 'NOT_FOUND');
  const code = (await doc(playerPath, host)).fields.inviteCode.stringValue;
  const candidates = [partner, other];
  const results = await Promise.all(candidates.map(user => call('joinRoom', {code}, user)));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 404]);
  const winner = candidates[results.findIndex(result => result.status === 200)];
  const loser = candidates.find(user => user !== winner);
  assert.equal((await call('joinRoom', {code}, winner)).result.roomId, roomId);
  assert.equal((await doc(roomPath, winner)).fields.status.stringValue, 'ready');
  assert.equal((await doc(roomPath, loser)).status, 403);
  const started = await call('startStory', { roomId, theme: 'Cozy Night', mood: 'Cute', rounds: 3, previousId: null }, host);
  assert.equal(started.status, 200);
  const storyId = started.result.id;
  const storyPath = roomPath + '/stories/' + storyId;
  assert.equal((await doc(storyPath, loser)).status, 403);
  const turn = turnNumber => ({
    roomId, storyId, turnNumber, requestId: randomUUID(),
    tiles: [{ kind: 'emoji', value: '💕' }], caption: 'Moment ' + turnNumber,
  });
  assert.equal((await call('playStoryTurn', turn(0), loser)).status, 403);
  assert.equal((await call('playStoryTurn', turn(0), winner)).status, 400);
  const first = turn(0);
  assert.equal((await call('playStoryTurn', first, host)).status, 200);
  assert.equal((await call('playStoryTurn', first, host)).status, 200);
  for (let number = 1; number < 6; number++) {
    assert.equal((await call('playStoryTurn', turn(number), number % 2 ? winner : host)).status, 200);
  }
  assert.equal((await doc(storyPath, winner)).fields.turns.arrayValue.values.length, 6);
  const story = { roomId, storyId };
  assert.equal((await call('generateStoryDraft', story, host)).error.status, 'FAILED_PRECONDITION');
  assert.equal((await call('reviewStory', { ...story, action: 'ai-consent', allowed: true }, host)).status, 200);
  assert.equal((await call('generateStoryDraft', story, host)).error.status, 'FAILED_PRECONDITION');
  assert.equal((await call('reviewStory', { ...story, action: 'ai-consent', allowed: true }, loser)).status, 403);
  assert.equal((await call('getSceneImage', story, loser)).status, 403);
  const entries = await doc(playerPath + '/notifications', host);
  assert.ok(entries.documents.length);
  assert.equal((await doc(playerPath + '/notifications', loser)).status, 403);
  const entryPath = entries.documents[0].name.split('/documents/')[1];
  const patch = fields => ({
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields }),
  });
  assert.equal((await doc(entryPath + '?updateMask.fieldPaths=message', host, patch({ message: { stringValue: 'Forged' } }))).status, 403);
  assert.equal((await doc(entryPath + '?updateMask.fieldPaths=read', host, patch({ read: { booleanValue: true } }))).status, 200);
  assert.equal((await call('leaveRoom', {}, winner)).status, 200);
  assert.equal((await doc(roomPath, host)).status, 403);
  assert.equal((await doc(storyPath, host)).status, 403);
  assert.equal((await doc(playerPath, host)).fields.roomId.nullValue, null);
});

test('shared-story and account deletion erase private objects and revoke access', async () => {
  const fnRequire = createRequire(new URL('../functions/package.json', import.meta.url));
  const { initializeApp, deleteApp } = fnRequire('firebase-admin/app');
  const { getStorage } = fnRequire('firebase-admin/storage');
  const { getFirestore } = fnRequire('firebase-admin/firestore');
  process.env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9198';
  process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8088';
  const admin = initializeApp({ projectId: project });
  const db = getFirestore(admin);
  const bucket = getStorage(admin).bucket(project + '.appspot.com');
  async function pair(host, partner) {
    const r = await call('createRoom', { title: 'Private test room' }, host);
    assert.equal(r.status, 200);
    const code = (await doc('players/' + host.localId, host)).fields.inviteCode.stringValue;
    assert.equal((await call('joinRoom', { code }, partner)).status, 200);
    return r.result.roomId;
  }
  async function fixture(path) {
    const object = bucket.file(path);
    await object.save(Buffer.from('emulator-only test bytes'), { resumable: false });
    return object;
  }
  try {
    const [host, partner, outsider] = await Promise.all([account(), account(), account()]);
    const roomId = await pair(host, partner);
    const settings = { roomId, theme: 'Cozy Night', mood: 'Cute', rounds: 3, previousId: null };
    const started = await call('startStory', settings, host);
    assert.equal(started.status, 200);
    const storyId = started.result.id;
    const room = db.doc('rooms/' + roomId);
    const story = room.collection('stories').doc(storyId);
    const image = await fixture('rooms/' + roomId + '/scenes/' + storyId + '/postcard.jpg');
    const descendant = story.parent.doc();
    await descendant.set({ origin: { storyId, title: 'Copied title', ending: 'Copied ending' }, turns: ['Independent turn'] });
    assert.equal((await call('deleteSharedStory', { roomId, storyId }, outsider)).status, 403);
    await story.update({ scene: { status: 'generating', expiresAt: Date.now() + 60000 } });
    assert.equal((await call('deleteSharedStory', { roomId, storyId }, partner)).error.status, 'FAILED_PRECONDITION');
    await story.update({ scene: { status: 'ready', attempt: 'postcard' } });
    assert.equal((await call('deleteSharedStory', { roomId, storyId }, partner)).status, 200);
    assert.equal((await call('deleteSharedStory', { roomId, storyId }, host)).status, 200);
    assert.equal((await story.get()).exists, false);
    assert.equal((await room.get()).data().activeStoryId, undefined);
    assert.deepEqual((await descendant.get()).data(), { turns: ['Independent turn'] });
    assert.equal((await image.exists())[0], false);
    assert.equal((await db.collection('players/' + partner.localId + '/notifications').where('storyId', '==', storyId).get()).empty, true);

    const remainingImage = await fixture('rooms/' + roomId + '/scenes/' + descendant.id + '/comic.jpg');
    const avatar = await fixture('avatars/' + host.localId + '/version/portrait.jpg');
    const avatarVersion = db.doc('avatars/' + host.localId + '/versions/version');
    await avatarVersion.set({ provider: 'openai' });
    assert.equal((await call('leaveRoom', {}, partner)).status, 200);
    const otherRoom = await pair(partner, outsider);
    const activeRoom = await call('createRoom', { title: 'Host waiting room' }, host);
    assert.equal(activeRoom.status, 200);
    const savedRoom = activeRoom.result.roomId;
    const code = (await doc('players/' + host.localId, host)).fields.inviteCode.stringValue;
    const oldInvite = db.doc('roomInvitations/' + createHash('sha256').update(code).digest('hex'));
    assert.equal((await call('deleteMyAccount', {}, host)).status, 200);
    for (const ref of [room, descendant, db.doc('rooms/' + savedRoom), avatarVersion, oldInvite, db.doc('players/' + host.localId)]) {
      assert.equal((await ref.get()).exists, false, ref.path);
    }
    assert.equal((await avatar.exists())[0], false);
    assert.equal((await remainingImage.exists())[0], false);
    assert.equal((await db.collection('players/' + partner.localId + '/notifications').where('roomId', '==', roomId).get()).empty, true);
    assert.equal((await doc('rooms/' + otherRoom, partner)).status, 200);
    assert.equal((await call('createRoom', { title: 'Should not exist' }, host)).status >= 400, true);
    assert.equal((await doc('preferences/' + host.localId, host, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { notificationBadge: { booleanValue: false } } }),
    })).status >= 400, true);
    const signIn = await fetch(auth + 'signInWithPassword?key=local-demo-key', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: host.email, password: 'local-passphrase', returnSecureToken: true }),
    });
    assert.equal(signIn.ok, false);
  } finally {
    await db.terminate();
    await deleteApp(admin);
  }
});
