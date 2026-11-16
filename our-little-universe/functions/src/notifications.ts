import { FieldValue, getFirestore, type Transaction } from 'firebase-admin/firestore';

export function notifyPlayer(tx: Transaction, uid: string, roomId: string, event: string, message: string, storyId?: string) {
  const entry = getFirestore().collection('players').doc(uid).collection('notifications').doc();
  tx.create(entry, { event, message, roomId, ...(storyId ? { storyId } : {}), createdAt: FieldValue.serverTimestamp(), read: false });
}
