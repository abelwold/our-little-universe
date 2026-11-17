import { useEffect, useState } from 'react';
import { EmailAuthProvider, reauthenticateWithCredential, sendEmailVerification, sendPasswordResetEmail, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot, setDoc } from 'firebase/firestore';
import { Link, useLocation } from 'react-router-dom';
import { auth, db, deleteMyAccount } from './firebase';

export function AccountPage({ user }: { user: User }) {
  const { search, hash } = useLocation();
  const verificationPrompt = new URLSearchParams(search).get('verify') === '1';
  const [verified, setVerified] = useState(user.emailVerified);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [badge, setBadge] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (verificationPrompt) return;
    return onSnapshot(doc(db, 'preferences', user.uid), snapshot => {
      setBadge(snapshot.data()?.notificationBadge !== false);
      setLoaded(true);
    }, () => setError('Could not load notification preferences.'));
  }, [user.uid, verificationPrompt]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try { await action(); }
    catch { setError('Could not update your account. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  async function erase() {
    if (!user.email || !password) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      try {
        await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
        await user.getIdToken(true);
      } catch {
        setError('Could not confirm your password. Check it or use password reset.');
        return;
      }
      setPassword('');
      await deleteMyAccount();
      await signOut(auth);
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Could not complete account deletion. Try again.');
    } finally { setBusy(false); }
  }

  const verification = verified ? <p>Email verified</p> : <>
      <p>Verify your email to unlock AI features on the live site.</p>
      <div className="actions">
        <button className="button" disabled={busy} onClick={() => void run(async () => {
          await sendEmailVerification(user);
          setNotice('Check your inbox for the verification link.');
        })}>Send verification email</button>
        <button className="button secondary" disabled={busy} onClick={() => void run(async () => {
          await user.reload();
          await user.getIdToken(true);
          setVerified(user.emailVerified);
          setNotice(user.emailVerified ? 'Your email is verified.' : 'Open the verification link in your email first.');
        })}>Check verification</button>
      </div>
  </>;

  if (verificationPrompt) return <section className="panel">
    <h1>Verify your email</h1>
    <p>{user.email}</p>
    {verification}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="divider">
      <Link className={verified ? 'button' : 'button secondary'} to={{ pathname: '/room', hash }} replace>
        {verified ? 'Continue to your room' : 'Verify later'}
      </Link>
    </div>
  </section>;

  return <section className="panel">
    <Link className="quiet" to="/room">← Your room</Link>
    <h1>Your account</h1>
    <p>{user.email}</p>
    {verification}
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
    {user.email && <details className="divider">
      <summary>Delete account</summary>
      <p>Permanently delete your sign-in, avatars, and all rooms you’ve shared, including their stories and artwork. Your partners will also lose access. This cannot be undone. Any copies already downloaded are unaffected.</p>
      <form onSubmit={event => { event.preventDefault(); void erase(); }}>
        <label>Confirm your password<input type="password" autoComplete="current-password" required
          value={password} onChange={event => setPassword(event.target.value)} disabled={busy} /></label>
        <button className="button secondary" disabled={busy || !password}>
          {busy ? 'Please wait…' : 'Permanently delete my account'}
        </button>
      </form>
    </details>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
