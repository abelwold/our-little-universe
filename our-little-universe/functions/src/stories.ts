import { FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError, onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { notifyPlayer } from './notifications';

const options = { region: 'us-central1', maxInstances: 10 };
const themes = ['First Date', 'Movie Night', 'Surprise Visit', 'Long-Distance Reunion', 'Dream Vacation', 'Cozy Night',
  'Rainy Day Romance', 'Mystery Date', 'Flirty Chaos', 'How We Met', 'Dream Future', 'Random Adventure'];
const moods = ['Cute', 'Romantic', 'Flirty', 'Funny', 'Chaotic'];
const actions = ['Wave', 'Dance', 'Give flowers', 'Hold hands', 'Hug'];
const emoji = /^(?:\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*(?:\u200D\p{Extended_Pictographic}[\uFE0F\p{Emoji_Modifier}]*)*|\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3)$/u;
export const validId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9]{20}$/.test(value);

type ReviewTurn = { uid: string; caption: string; tiles: { kind: string; value: string }[] };
const actionBeats: Record<string, string> = {
  Wave: 'waved', Dance: 'danced', 'Give flowers': 'gave flowers', 'Hold hands': 'held hands', Hug: 'shared a hug',
};

function draftFromTimeline(turns: ReviewTurn[], firstPlayer: string) {
  return turns.map(turn => {
    if (turn.caption) return turn.caption;
    const character = turn.uid === firstPlayer ? 'The first storyteller' : 'Their partner';
    const actions = turn.tiles.filter(tile => tile.kind === 'action').map(tile => actionBeats[tile.value]).filter(Boolean);
    const emojis = turn.tiles.filter(tile => tile.kind === 'emoji').map(tile => tile.value);
    const moment = actions.length ? character + ' ' + actions.join(' and ') + '.' : character + ' added a moment.';
    return [moment, ...emojis].join(' ');
  }).join('\n\n');
}

export function player(request: CallableRequest) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in to play.');
  return request.auth.uid;
}

export async function joinedRoom(tx: Transaction, roomId: unknown, uid: string) {
  if (!validId(roomId)) throw new HttpsError('invalid-argument', 'Choose a room.');
  const ref = getFirestore().collection('rooms').doc(roomId);
  const data = (await tx.get(ref)).data();
  if (data?.status !== 'ready' || ![data.ownerId, data.partnerId].includes(uid)) {
    throw new HttpsError('permission-denied', 'Join an active room with your partner to play.');
  }
  return { ref, data };
}

function readTiles(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) {
    throw new HttpsError('invalid-argument', 'Add one to three tiles.');
  }
  return value.map(tile => {
    if (tile?.kind === 'emoji' && typeof tile.value === 'string' && tile.value.length <= 32 && emoji.test(tile.value)) {
      return { kind: 'emoji', value: tile.value };
    }
    if (tile?.kind === 'action' && actions.includes(tile.value)) return { kind: 'action', value: tile.value as string };
    if (tile?.kind === 'avatar' && tile.value === 'me') return { kind: 'avatar', value: 'me' };
    throw new HttpsError('invalid-argument', 'Choose a supported story tile.');
  });
}

export const startStory = onCall(options, async request => {
  const uid = player(request);
  const { roomId, theme, mood, rounds, previousId, origin } = request.data ?? {};
  if (!themes.includes(theme) || !moods.includes(mood) || ![3, 5, 7].includes(rounds) ||
      !(previousId === null || validId(previousId))) {
    throw new HttpsError('invalid-argument', 'Choose a theme, mood and story length.');
  }
  if (origin !== undefined && (!validId(origin?.storyId) || !['continue', 'remix'].includes(origin?.mode))) {
    throw new HttpsError('invalid-argument', 'Choose an approved story to continue or remix.');
  }
  return getFirestore().runTransaction(async tx => {
    const { ref, data } = await joinedRoom(tx, roomId, uid);
    const activeId = data.activeStoryId ?? null;
    if (activeId !== previousId) return { id: activeId };
    if (activeId) {
      const active = await tx.get(ref.collection('stories').doc(activeId));
      if (active.data()?.status !== 'complete') throw new HttpsError('failed-precondition', 'Finish your current story first.');
    }
    const source = origin ? (await tx.get(ref.collection('stories').doc(origin.storyId))).data() : undefined;
    if (origin && !source?.review?.finalizedAt) throw new HttpsError('failed-precondition', 'Both players must approve the original story.');
    const story = ref.collection('stories').doc();
    tx.create(story, {
      theme, mood, rounds, players: [data.ownerId, data.partnerId], nextPlayer: uid,
      turns: [], status: 'playing', createdAt: FieldValue.serverTimestamp(),
      ...(source ? { origin: {
        mode: origin.mode, storyId: origin.storyId, title: source.review.title,
        ...(origin.mode === 'continue' ? { ending: source.review.ending } : {}),
      } } : {}),
    });
    tx.update(ref, { activeStoryId: story.id });
    notifyPlayer(tx, data.ownerId === uid ? data.partnerId : data.ownerId, roomId, 'story-started', 'Your partner started a story.', story.id);
    return { id: story.id };
  });
});

export const playStoryTurn = onCall(options, async request => {
  const uid = player(request);
  const { roomId, storyId, turnNumber, requestId, tiles, caption } = request.data ?? {};
  if (!validId(storyId) || !Number.isInteger(turnNumber) || turnNumber < 0 || turnNumber > 13 ||
      typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(requestId) ||
      typeof caption !== 'string' || caption.length > 180) {
    throw new HttpsError('invalid-argument', 'This turn could not be submitted. Check the caption and try again.');
  }
  const choices = readTiles(tiles);
  return getFirestore().runTransaction(async tx => {
    const { ref, data } = await joinedRoom(tx, roomId, uid);
    const story = ref.collection('stories').doc(storyId);
    const current = (await tx.get(story)).data();
    const accepted = current?.turns[turnNumber];
    if (accepted?.requestId === requestId && accepted.uid === uid) return { accepted: true };
    if (!current || data.activeStoryId !== storyId || current.status !== 'playing') {
      throw new HttpsError('failed-precondition', 'This story is already finished or unavailable.');
    }
    if (current.nextPlayer !== uid || current.turns.length !== turnNumber) {
      throw new HttpsError('failed-precondition', 'This turn has changed. Check the timeline before sending.');
    }

    let avatar: { starter?: string; versionId?: string } = {};
    if (choices.some(tile => tile.kind === 'avatar')) {
      const profile = getFirestore().collection('avatars').doc(uid);
      const versionId = (await tx.get(profile)).data()?.approvedId;
      if (validId(versionId)) {
        const version = (await tx.get(profile.collection('versions').doc(versionId))).data();
        if (version?.provider === 'starter') avatar = { starter: version.starter, versionId };
        if (version?.provider === 'openai') avatar = { versionId };
      }
    }
    const selected = choices.map(tile => tile.kind === 'avatar' ? { ...tile, ...avatar } : tile);
    const turns = [...current.turns, { uid, requestId, tiles: selected, caption: caption.trim() }];
    const complete = turns.length === current.rounds * 2;
    const partner = current.players.find((id: string) => id !== uid);
    tx.update(story, {
      turns, status: complete ? 'complete' : 'playing',
      nextPlayer: complete ? null : partner,
      updatedAt: FieldValue.serverTimestamp(),
      ...(complete ? { completedAt: FieldValue.serverTimestamp() } : {}),
    });
    notifyPlayer(tx, partner, roomId, complete ? 'review-ready' : 'your-turn',
      complete ? 'Your finished timeline is ready for review.' : 'It’s your turn to add to the story.', storyId);
    return { accepted: true };
  });
});

export const reviewStory = onCall(options, async request => {
  const uid = player(request);
  const { roomId, storyId, action, revision, title, narrative, ending } = request.data ?? {};
  if (!validId(storyId) || !['draft', 'save', 'approve', 'ai-consent'].includes(action) ||
      (action === 'ai-consent' && typeof request.data?.allowed !== 'boolean')) {
    throw new HttpsError('invalid-argument', 'Choose a completed story.');
  }
  if (action === 'save' && (
    typeof title !== 'string' || !title.trim() || title.length > 100 ||
    typeof narrative !== 'string' || !narrative.trim() || narrative.length > 4000 ||
    typeof ending !== 'string' || ending.length > 400
  )) throw new HttpsError('invalid-argument', 'Check the title, story text, and ending.');

  return getFirestore().runTransaction(async tx => {
    const { ref } = await joinedRoom(tx, roomId, uid);
    const storyRef = ref.collection('stories').doc(storyId);
    const story = (await tx.get(storyRef)).data();
    if (story?.status !== 'complete') throw new HttpsError('failed-precondition', 'Finish the timeline before reviewing it.');
    const review = story.review;

    if (action === 'ai-consent') {
      if (review?.finalizedAt) throw new HttpsError('failed-precondition', 'This story is already final.');
      tx.update(storyRef, {
        aiDraftConsents: request.data.allowed ? FieldValue.arrayUnion(uid) : FieldValue.arrayRemove(uid),
      });
      return { saved: true };
    }

    if (action === 'draft') {
      if (!review) tx.update(storyRef, { review: {
        title: story.theme, narrative: draftFromTimeline(story.turns, story.turns[0].uid),
        ending: '', revision: 1, approvals: [],
      } });
      return { saved: true };
    }
    if (!review || review.revision !== revision) {
      throw new HttpsError('failed-precondition', 'The draft changed. Open the latest version before editing or approving.');
    }
    if (action === 'approve') {
      if (!review.ending) throw new HttpsError('failed-precondition', 'Save an ending before approving.');
      if (review.approvals.includes(uid)) return { saved: true };
      const approvals = [...review.approvals, uid];
      const final = story.players.every((id: string) => approvals.includes(id));
      tx.update(storyRef, {
        'review.approvals': approvals,
        ...(final ? { 'review.finalizedAt': FieldValue.serverTimestamp() } : {}),
      });
      const partner = story.players.find((id: string) => id !== uid);
      notifyPlayer(tx, partner, roomId, final ? 'story-approved' : 'partner-approved',
        final ? 'Your story is approved and ready to illustrate.' : 'Your partner approved the story draft.', storyId);
      return { saved: true };
    }
    if (review.finalizedAt) throw new HttpsError('failed-precondition', 'Both partners approved this story. It is final.');
    const updated = { title: title.trim(), narrative: narrative.trim(), ending: ending.trim() };
    if (review.title === updated.title && review.narrative === updated.narrative && review.ending === updated.ending) {
      return { saved: true };
    }
    tx.update(storyRef, { review: { ...updated, revision: revision + 1, approvals: [] } });
    return { saved: true };
  });
});
