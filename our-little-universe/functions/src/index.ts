import { createHash, randomBytes } from 'node:crypto';
import { initializeApp } from 'firebase-admin/app';
import { FieldValue, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { CallableRequest, HttpsError, onCall } from 'firebase-functions/v2/https';
import { notifyPlayer } from './notifications';

initializeApp();
const db = getFirestore();
const players = db.collection('players');
const rooms = db.collection('rooms');
const invitations = db.collection('roomInvitations');
const options = { region: 'us-central1', maxInstances: 10 };
const inviteLifetime = 24 * 60 * 60 * 1000;
const clearInvite = { inviteCode: FieldValue.delete(), inviteExpiresAt: FieldValue.delete(), lastJoinedInvite: FieldValue.delete() };

function player(request: CallableRequest): string {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to use your room.');
  return request.auth.uid;
}

export { generateAvatar, approveAvatar, removeAvatar, generateAvatarExpression, getAvatarImage, selectStarterAvatar } from './avatars';
export { startStory, playStoryTurn, reviewStory } from './stories';
export { generateStoryDraft } from './interpretation';
export { setSceneConsent, generateScene, getSceneImage, updateStorybookActivity } from './scenes';

function invitation(code: string) {
  return invitations.doc(createHash('sha256').update(code).digest('hex'));
}

function newInvite() {
  return { code: randomBytes(8).toString('hex'), expiresAt: Timestamp.fromMillis(Date.now() + inviteLifetime) };
}

export const createRoom = onCall(options, async request => {
  const uid = player(request);
  const title = typeof request.data?.title === 'string' ? request.data.title.trim() : '';
  if (!title || title.length > 60) throw new HttpsError('invalid-argument', 'Use a room name between 1 and 60 characters.');
  const room = rooms.doc();
  const host = players.doc(uid);
  const invite = newInvite();
  return db.runTransaction(async tx => {
    const current = (await tx.get(host)).data();
    if (current?.roomId) return { roomId: current.roomId };
    tx.create(room, {
      title, ownerId: uid, partnerId: null, status: 'waiting', createdAt: FieldValue.serverTimestamp(),
    });
    tx.create(invitation(invite.code), { roomId: room.id, expiresAt: invite.expiresAt });
    tx.set(host, { roomId: room.id, inviteCode: invite.code, inviteExpiresAt: invite.expiresAt }, { merge: true });
    return { roomId: room.id };
  });
});

export const joinRoom = onCall(options, async request => {
  const uid = player(request);
  const code = typeof request.data?.code === 'string' ? request.data.code.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{16}$/.test(code)) throw new HttpsError('invalid-argument', 'Enter the 16-character invitation code.');
  return db.runTransaction(async tx => {
    const member = players.doc(uid);
    const memberData = (await tx.get(member)).data();
    if (memberData?.lastJoinedInvite === invitation(code).id && memberData.roomId) return { roomId: memberData.roomId };
    if (memberData?.roomId) throw new HttpsError('failed-precondition', 'Leave your current room before joining another.');
    const invite = invitation(code);
    const data = (await tx.get(invite)).data();
    if (!data || data.expiresAt.toMillis() <= Date.now()) {
      throw new HttpsError('not-found', 'That invite expired or was already used.');
    }
    const room = rooms.doc(data.roomId);
    const current = (await tx.get(room)).data();
    if (!current || current.status !== 'waiting' || current.partnerId || current.ownerId === uid) {
      throw new HttpsError('failed-precondition', 'This room is unavailable.');
    }
    tx.update(room, { partnerId: uid, status: 'ready', joinedAt: FieldValue.serverTimestamp() });
    tx.set(member, { roomId: room.id, lastJoinedInvite: invite.id }, { merge: true });
    tx.update(players.doc(current.ownerId), { roomId: room.id, ...clearInvite });
    tx.delete(invite);
    notifyPlayer(tx, current.ownerId, room.id, 'joined', 'Your partner joined the room.');
    return { roomId: room.id };
  });
});

export const replaceInvite = onCall(options, async request => {
  const uid = player(request);
  const next = newInvite();
  return db.runTransaction(async tx => {
    const host = players.doc(uid);
    const member = (await tx.get(host)).data();
    if (!member?.roomId) throw new HttpsError('failed-precondition', 'Create a room first.');
    const room = (await tx.get(rooms.doc(member.roomId))).data();
    if (room?.ownerId !== uid || room.status !== 'waiting') {
      throw new HttpsError('permission-denied', 'Only the host of a waiting room can replace its invite.');
    }
    if (member.inviteCode) tx.delete(invitation(member.inviteCode));
    tx.create(invitation(next.code), { roomId: member.roomId, expiresAt: next.expiresAt });
    tx.update(host, { inviteCode: next.code, inviteExpiresAt: next.expiresAt });
    return { roomId: member.roomId };
  });
});

export const leaveRoom = onCall(options, async request => {
  const uid = player(request);
  await db.runTransaction(async tx => {
    const member = (await tx.get(players.doc(uid))).data();
    if (!member?.roomId) return;
    const room = rooms.doc(member.roomId);
    const data = (await tx.get(room)).data();
    if (!data || ![data.ownerId, data.partnerId].includes(uid)) {
      throw new HttpsError('permission-denied', 'Only room members can close the room.');
    }
    if (member.inviteCode) tx.delete(invitation(member.inviteCode));
    tx.update(room, { status: 'ended', endedAt: FieldValue.serverTimestamp() });
    tx.update(players.doc(data.ownerId), { roomId: null, ...clearInvite });
    if (data.partnerId) tx.update(players.doc(data.partnerId), { roomId: null, ...clearInvite });
  });
  return { left: true };
});
