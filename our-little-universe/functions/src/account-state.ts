import { getFirestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';

export async function requireActiveAccount(uid: string, tx?: Transaction) {
  const marker = getFirestore().collection('accountRemovals').doc(uid);
  if ((await (tx ? tx.get(marker) : marker.get())).exists) {
    throw new HttpsError('permission-denied', 'This account is being deleted.');
  }
}
