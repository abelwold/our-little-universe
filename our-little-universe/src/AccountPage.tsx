import { useEffect, useState } from 'react';
import { sendEmailVerification, sendPasswordResetEmail, type User } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { auth, db } from './firebase';

export function AccountPage({ user }: { user: User }) {
  const [verified, setVerified] = useState(user.emailVerified);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [badge, setBadge] = useState(true);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => onSnapshot(doc(db, 'preferences', user.uid), snapshot => {
    setBadge(snapshot.data()?.notificationBadge !== false);
    setLoaded(true);
  }, () => setError('Could not load notification preferences.')), [user.uid]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch { setError('Could not update your account. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  return <section className="panel">
    <Link className="quiet" to="/room">← Your room</Link>
    <h1>Your account</h1>
    <p>{user.email}</p>
    {verified ? <p>Email verified</p> : <>
      <p>Verify your email to unlock AI features on the live site.</p>
      <div className="actions">
        <button className="button" disabled={busy} onClick={() => void run(async () => {
          await sendEmailVerification(user);
          setNotice('Check your inbox for the verification link.');
        })}>Send verification email</button>
        <button className="quiet" disabled={busy} onClick={() => void run(async () => {
          await user.reload();
          await user.getIdToken(true);
          setVerified(user.emailVerified);
          setNotice(user.emailVerified ? 'Your email is verified.' : 'Open the verification link in your email first.');
        })}>Check verification</button>
      </div>
    </>}
    {user.email && <button className="quiet" disabled={busy} onClick={() => void run(async () => {
      if (!user.email) return;
      await sendPasswordResetEmail(auth, user.email);
      setNotice('Check your inbox for the password reset link.');
    })}>Email me a password reset link</button>}
    <div className="divider">
      <h2>Notifications</h2>
      <label className="avatar-consent"><input type="checkbox" checked={badge} disabled={busy || !loaded}
        onChange={event => {
          const notificationBadge = event.target.checked;
          void run(() => setDoc(doc(db, 'preferences', user.uid), { notificationBadge }));
        }} /> Show unread count</label>
    </div>
    <Link className="button secondary" to="/avatar">Manage your avatar</Link>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
