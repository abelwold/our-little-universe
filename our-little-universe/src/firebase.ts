import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from 'firebase/functions';

const projectId = import.meta.env.VITE_FIREBASE_PROJECT_ID;
export const local = !projectId && ['localhost', '127.0.0.1'].includes(location.hostname);
export const configured = local || Boolean(projectId && import.meta.env.VITE_FIREBASE_API_KEY);
const app = initializeApp({
  projectId: projectId || 'demo-our-little-universe',
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'local-demo-key',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});
export const auth = getAuth(app);
export const db = getFirestore(app);
const functions = getFunctions(app, 'us-central1');

if (local) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9098', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8088);
  connectFunctionsEmulator(functions, '127.0.0.1', 5011);
}

export const createRoom = httpsCallable<{ title: string }, { roomId: string }>(functions, 'createRoom');
export const joinRoom = httpsCallable<{ code: string }, { roomId: string }>(functions, 'joinRoom');
export const replaceInvite = httpsCallable<void, { roomId: string }>(functions, 'replaceInvite');
export const leaveRoom = httpsCallable<void, { left: boolean }>(functions, 'leaveRoom');
export const avatarExpressions = ['smiling', 'laughing', 'blushing', 'winking', 'surprised', 'flirty', 'kissing'] as const;
export type AvatarExpression = typeof avatarExpressions[number];
export type StarterAvatar = 'moon' | 'sun' | 'comet' | 'planet';
export type AvatarPreview = {
  id: string;
  provider: 'openai' | 'mock' | 'starter';
  starter?: StarterAvatar;
  expressions?: AvatarExpression[];
};
export const selectStarterAvatar = httpsCallable<{ starter: StarterAvatar }, { id: string }>(functions, 'selectStarterAvatar');
export const generateAvatar = httpsCallable<{ photo: string; consent: boolean }, { id: string }>(
  functions, 'generateAvatar', { timeout: 310_000 },
);
export const generateAvatarExpression = httpsCallable<{ id: string; expression: AvatarExpression }, { expression: AvatarExpression }>(
  functions, 'generateAvatarExpression', { timeout: 310_000 },
);
export const getAvatarImage = httpsCallable<{ id: string; image: 'portrait' | AvatarExpression }, { jpeg: string }>(
  functions, 'getAvatarImage',
);
export const approveAvatar = httpsCallable<{ id: string }, { id: string }>(functions, 'approveAvatar');
export const removeAvatar = httpsCallable<{ id: string }, { id: string }>(functions, 'removeAvatar');
export type StoryTile = {
  kind: 'emoji' | 'action' | 'avatar';
  value: string;
  starter?: StarterAvatar;
  versionId?: string;
};
export const startStory = httpsCallable<{
  roomId: string; theme: string; mood: string; rounds: number; previousId: string | null;
  origin?: { storyId: string; mode: 'continue' | 'remix' };
}, { id: string }>(functions, 'startStory');
export const playStoryTurn = httpsCallable<{
  roomId: string; storyId: string; turnNumber: number; requestId: string; tiles: StoryTile[]; caption: string;
}, { accepted: boolean }>(functions, 'playStoryTurn');
type ReviewAction = { action: 'draft' } | { action: 'ai-consent'; allowed: boolean } | { action: 'approve'; revision: number } |
  { action: 'save'; revision: number; title: string; narrative: string; ending: string };
export const reviewStory = httpsCallable<ReviewAction & { roomId: string; storyId: string }, { saved: boolean }>(
  functions, 'reviewStory',
);
type SceneTarget = { roomId: string; storyId: string };
export const deleteSharedStory = httpsCallable<SceneTarget, { deleted: boolean }>(functions, 'deleteSharedStory', { timeout: 250_000 });
export const deleteMyAccount = httpsCallable<void, { deleted: boolean }>(functions, 'deleteMyAccount', { timeout: 250_000 });
export type AiDraftStatus = { status: 'generating' | 'failed'; token?: string; expiresAt?: number; message?: string };
export const generateStoryDraft = httpsCallable<SceneTarget, { saved: boolean }>(functions, 'generateStoryDraft', { timeout: 110_000 });
export type StoryReaction = 'love' | 'funny' | 'sweet' | 'flirty';
export type StorybookActivity = { favorites?: string[]; reactions?: { uid: string; reaction: StoryReaction }[] };
export const updateStorybookActivity = httpsCallable<SceneTarget & (
  { kind: 'favorite'; selected: boolean } | { kind: 'reaction'; reaction: StoryReaction | null }
), { saved: boolean }>(functions, 'updateStorybookActivity');
type ImageTarget = SceneTarget & { format?: 'scene' | 'comic' };
export type Scene = { status: 'generating' | 'ready' | 'failed'; attempt: string; expiresAt?: number; message?: string };
export type SceneConsent = { uid: string; versionId: string | null; expression?: AvatarExpression };
export const setSceneConsent = httpsCallable<SceneTarget & {
  choice: 'avatar' | 'fictional' | 'withdraw'; expression?: AvatarExpression | null; selectedVersionId?: string;
}, { saved: boolean }>(
  functions, 'setSceneConsent',
);
export const generateScene = httpsCallable<ImageTarget, { started: boolean }>(functions, 'generateScene', { timeout: 310_000 });
export const getSceneImage = httpsCallable<ImageTarget, { jpeg: string }>(functions, 'getSceneImage');
