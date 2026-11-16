import { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { createUserWithEmailAndPassword, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, type User } from 'firebase/auth';
import { doc, onSnapshot, type Timestamp } from 'firebase/firestore';
import { ArrowRight, Heart, Sparkles, Orbit, Link2, LockKeyhole } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { auth, configured, db, createRoom, joinRoom, replaceInvite, leaveRoom } from './firebase';
import './style.css';
import { Notifications } from './Notifications';

const AvatarPage = lazy(() => import('./AvatarPage').then(module => ({ default: module.AvatarPage })));
const StoryPage = lazy(() => import('./StoryPage').then(module => ({ default: module.StoryPage })));
const Storybook = lazy(() => import('./Storybook').then(module => ({ default: module.Storybook })));
const AccountPage = lazy(() => import('./AccountPage').then(module => ({ default: module.AccountPage })));

const inviteCode = (hash: string) => new URLSearchParams(hash.slice(1)).get('invite') ?? '';
const credentials = z.object({ email: z.email(), password: z.string().min(6, 'Use at least six characters.') });
type Membership = { roomId: string; inviteCode?: string; inviteExpiresAt?: Timestamp };
type Room = { title: string; ownerId: string; partnerId: string | null; status: 'waiting' | 'ready' };

function message(error: unknown) {
  if (error instanceof Error && !error.message.startsWith('Firebase:')) return error.message;
  return 'That didn’t work. Check your details and try again.';
}
function ErrorText({ children }: { children: string }) {
  return children ? <p className="error" role="alert">{children}</p> : null;
}

function Home({ user }: { user: User | null }) {
  return <section className="hero">
    <div>
      <div className="kicker"><Sparkles size={15} /> A PRIVATE SPACE FOR TWO</div>
      <h1>Our Little<br /><em>Universe.</em></h1>
      <p>Make a little world together. One emoji, one inside joke, and one story at a time.</p>
      <Link className="button" to={user ? '/room' : '/login'}>Enter your universe <ArrowRight size={18} /></Link>
    </div>
    <div className="art" aria-hidden="true">
      <div className="ring r1"/><div className="ring r2"/>
      <span className="star st1">✦</span><span className="star st2">✧</span><span className="star st3">✦</span>
      <div className="planet"><Heart fill="currentColor" strokeWidth={0} /></div>
      <span className="moon">☾</span><span className="satellite">✦</span>
    </div>
  </section>;
}

function Login({ user }: { user: User | null }) {
  const [signup, setSignup] = useState(false);
  const [error, setError] = useState('');
  const [resetNotice, setResetNotice] = useState('');
  const form = useForm<z.infer<typeof credentials>>();
  const { hash } = useLocation();
  if (user) return <Navigate to={{ pathname: '/room', hash }} replace />;
  return <section className="panel">
    <div className="kicker"><LockKeyhole size={15} /> JUST THE TWO OF YOU</div>
    <h1>{signup ? 'Make yourself at home.' : 'Welcome back.'}</h1>
    <p>{inviteCode(hash) ? 'Sign in or create an account to accept your invitation.' : 'Your shared space awaits.'}</p>
    <form onSubmit={form.handleSubmit(async data => {
      setError('');
      const parsed = credentials.safeParse(data);
      if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
      try {
        if (signup) await createUserWithEmailAndPassword(auth, parsed.data.email, parsed.data.password);
        else await signInWithEmailAndPassword(auth, parsed.data.email, parsed.data.password);
      } catch (error) { setError(message(error)); }
    })}>
      <label>Email<input type="email" autoComplete="email" required {...form.register('email')} /></label>
      <label>Password<input type="password" autoComplete={signup ? 'new-password' : 'current-password'} required {...form.register('password')} /></label>
      <ErrorText>{error}</ErrorText>
      <button className="button" disabled={form.formState.isSubmitting}>{signup ? 'Create account' : 'Sign in'} <ArrowRight size={18} /></button>
    </form>
    {!signup && <button className="quiet" type="button" onClick={async () => {
      setResetNotice('');
      setError('');
      const email = z.email().safeParse(form.getValues('email')?.trim());
      if (!email.success) { setError('Enter your email address to reset your password.'); return; }
      try { await sendPasswordResetEmail(auth, email.data); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'auth/user-not-found') {
          setError('Could not request a reset link. Try again.'); return;
        }
      }
      setResetNotice('If this email has an account, check its inbox for a reset link.');
    }}>Forgot password?</button>}
    {resetNotice && <p role="status">{resetNotice}</p>}
    <button className="quiet" onClick={() => {setSignup(!signup);setError('');}}>{signup ? 'Already have an account? Sign in' : 'New here? Create an account'}</button>
  </section>;
}

function RoomPage({ user }: { user: User }) {
  const [member, setMember] = useState<Membership | null>();
  const [room, setRoom] = useState<Room>();
  const [title, setTitle] = useState('');
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [code, setCode] = useState(() => inviteCode(hash));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [confirming, setConfirming] = useState(false);
  const roomId = member?.roomId;

  useEffect(() => onSnapshot(doc(db, 'players', user.uid), snapshot => {
    const data = snapshot.data() as Membership | undefined;
    setMember(data?.roomId ? data : null);
  }, error => setError(message(error))), [user.uid]);

  useEffect(() => {
    setRoom(undefined);
    setConfirming(false);
    if (roomId) return onSnapshot(doc(db, 'rooms', roomId), snapshot => {
      if (snapshot.exists()) setRoom(snapshot.data() as Room);
    }, error => {
      if (error.code === 'permission-denied') {
        setMember(current => current?.roomId === roomId ? null : current);
      } else {
        setError(message(error));
      }
    });
  }, [roomId]);

  async function run(task: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    setStatus('');
    try { await task(); } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  if (member === undefined || (member && !room)) return <section className="panel"><h1>Finding your universe…</h1><ErrorText>{error}</ErrorText></section>;
  if (!member || !room) return <section className="panel">
    <div className="kicker"><Orbit size={16} /> YOUR SHARED SPACE</div>
    <h1>Make it yours.</h1>
    <p>Start a room or use the invitation your partner sent.</p>
    <form onSubmit={e => {e.preventDefault();void run(() => createRoom({title}));}}>
      <label>Room name<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={60} placeholder="The two of us" /></label>
      <button className="button" disabled={busy}>Create a room <ArrowRight size={18} /></button>
    </form>
    <form className="divider" onSubmit={e => {e.preventDefault();void run(async () => {
      await joinRoom({code});
      setCode('');
      if (hash) navigate('/room', { replace: true });
    });}}>
      <label>Invitation code<input value={code} onChange={e => setCode(e.target.value)} autoCapitalize="none" autoComplete="off" maxLength={16} required /></label>
      <button className="button secondary" disabled={busy}>Join your partner <Link2 size={17} /></button>
    </form>
    <ErrorText>{error}</ErrorText>
  </section>;

  const share = member.inviteCode ? location.origin + '/login#invite=' + member.inviteCode : '';
  return <section className="panel">
    <div className="kicker"><Heart size={15} /> {room.status === 'ready' ? 'TOGETHER' : 'WAITING FOR YOUR PARTNER'}</div>
    <h1>{room.title}</h1>
    {room.status === 'waiting' ? <>
      <p>Send your partner an invite. It expires after 24 hours.</p>
      <label>Invitation link<input readOnly value={share} onFocus={event => event.target.select()} /></label>
      <p>Invitation code <code>{member.inviteCode}</code></p>
      <div className="actions">
        <button className="button" disabled={!share} onClick={async () => {
          try { await navigator.clipboard.writeText(share);setStatus('Invite copied.'); }
          catch {setStatus('Select the link above to copy it.');}
        }}>Copy invitation <Link2 size={16} /></button>
        <button className="button secondary" disabled={busy} onClick={() => void run(replaceInvite)}>Replace invite</button>
      </div>
      <p role="status">{status}</p>
    </> : <p>Your partner is here. This is your private space for two.</p>}
    <div className="actions">
      {room.status === 'ready' && <Link className="button" to={'/story?room=' + member.roomId}>Build a story</Link>}
      {room.status === 'ready' && <Link className="button secondary" to={'/storybook?room=' + member.roomId}>Storybook</Link>}
      <Link className="button secondary" to="/avatar">Set up your avatar</Link>
    </div>
    <div className="divider">
      {confirming ? <><p>Close this room for both of you?</p><div className="actions">
        <button className="button secondary" disabled={busy} onClick={() => void run(async () => {
          await leaveRoom();
          setMember(current => current?.roomId === roomId ? null : current);
        })}>Close room for both</button>
        <button className="quiet" onClick={() => setConfirming(false)}>Keep room</button>
      </div></> : <button className="quiet" onClick={() => setConfirming(true)}>Leave room</button>}
    </div>
    <ErrorText>{error}</ErrorText>
  </section>;
}

function App() {
  const [user, setUser] = useState<User | null>();
  const { search } = useLocation();
  const params = new URLSearchParams(search);
  const storyRoomId = params.get('room') ?? '';
  const selectedStoryId = params.get('story') ?? '';
  const savedStoryId = /^[a-zA-Z0-9]{20}$/.test(selectedStoryId) ? selectedStoryId : undefined;
  useEffect(() => onAuthStateChanged(auth, setUser), []);
  return <div className="shell">
    <a className="button skip-link" href="#main-content">Skip to content</a>
    <header><Link className="brand" to="/"><Orbit size={25} /> Our Little Universe</Link>
      {user ? <div className="actions account-navigation"><Link className="quiet" to="/room">Your room</Link>
        <Link className="quiet" to="/account">Account</Link><Notifications key={user.uid} uid={user.uid} />
        <button className="quiet" onClick={() => void signOut(auth)}>Sign out</button></div>
        : <Link className="quiet" to="/login">Sign in</Link>}
    </header>
    <main id="main-content" tabIndex={-1}>{!configured ? <section className="panel"><h1>Connect Firebase</h1><p>Add the web app configuration to run this build.</p></section>
      : user === undefined ? <p role="status">Getting things ready…</p> : <Suspense fallback={<p role="status">Opening your universe…</p>}><Routes>
        <Route path="/" element={<Home user={user} />} />
        <Route path="/login" element={<Login user={user} />} />
        <Route path="/room" element={user ? <RoomPage key={user.uid} user={user} /> : <Navigate to="/login" replace />} />
        <Route path="/avatar" element={user ? <AvatarPage key={user.uid} uid={user.uid} /> : <Navigate to="/login" replace />} />
        <Route path="/account" element={user ? <AccountPage key={user.uid} user={user} /> : <Navigate to="/login" replace />} />
        <Route path="/story" element={!user ? <Navigate to="/login" replace />
          : /^[a-zA-Z0-9]{20}$/.test(storyRoomId) ? <StoryPage key={user.uid + storyRoomId + (savedStoryId ?? '')}
              uid={user.uid} roomId={storyRoomId} savedStoryId={savedStoryId} />
          : <Navigate to="/room" replace />} />
        <Route path="/storybook" element={!user ? <Navigate to="/login" replace />
          : /^[a-zA-Z0-9]{20}$/.test(storyRoomId) ? <Storybook key={user.uid + storyRoomId} roomId={storyRoomId} uid={user.uid} />
          : <Navigate to="/room" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes></Suspense>}</main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<BrowserRouter><App /></BrowserRouter>);
