import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { doc, collection, getDocFromServer, getDocsFromServer, orderBy, query } from 'firebase/firestore';
import { Moon, Orbit, Sparkles, Sun } from 'lucide-react';
import { Link } from 'react-router-dom';
import {
  approveAvatar, avatarExpressions, db, generateAvatar, generateAvatarExpression, getAvatarImage, removeAvatar, selectStarterAvatar,
  type AvatarExpression, type AvatarPreview, type StarterAvatar,
} from './firebase';

type ApprovedAvatar = AvatarPreview & { number: number };
type AvatarState = { draft?: AvatarPreview; approvedId?: string; versions: ApprovedAvatar[] };
type Generation = { startedAt: number; message: string; avatarId?: string };
const starters = [
  { id: 'moon', name: 'Moon', Icon: Moon },
  { id: 'sun', name: 'Sun', Icon: Sun },
  { id: 'comet', name: 'Comet', Icon: Sparkles },
  { id: 'planet', name: 'Saturn', Icon: Orbit },
] as const;

async function preparePhoto(file: File) {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 8 * 1024 * 1024) {
    throw new Error('Choose a JPEG, PNG, or WebP photo up to 8 MB.');
  }
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' }).catch(() => {
    throw new Error('This photo could not be opened. Try a different one.');
  });
  try {
    const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare the photo.');
    context.fillStyle = '#fff6f2';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.9);
  } finally {
    bitmap.close();
  }
}

async function readAvatar(uid: string): Promise<AvatarState> {
  const avatar = doc(db, 'avatars', uid);
  const [profile, versions] = await Promise.all([
    getDocFromServer(avatar),
    getDocsFromServer(query(collection(avatar, 'versions'), orderBy('number', 'desc'))),
  ]);
  return { ...profile.data(), versions: versions.docs.map(item => item.data() as ApprovedAvatar) };
}

function GenerationStatus({ startedAt, message }: Generation) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const update = () => setElapsed(Math.floor((performance.now() - startedAt) / 1000));
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);

  const minutes = Math.floor(elapsed / 60);
  const seconds = String(elapsed % 60).padStart(2, '0');
  return <div className="avatar-generation">
    <span className="avatar-spinner" aria-hidden="true" />
    <span role="status">{message}</span>
    <span className="avatar-elapsed">{minutes}:{seconds} elapsed</span>
  </div>;
}

function AvatarImage({ avatar, image = 'portrait', onLoaded }: {
  avatar: AvatarPreview;
  image?: 'portrait' | AvatarExpression;
  onLoaded?: () => void;
}) {
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const id = avatar.id;
  const isGenerated = avatar.provider === 'openai';
  useEffect(() => {
    if (!isGenerated) return;
    let active = true;
    setError('');
    setSource('');
    void getAvatarImage({ id, image })
      .then(({ data }) => { if (active) setSource('data:image/jpeg;base64,' + data.jpeg); })
      .catch(() => { if (active) setError('Could not load the generated image.'); });
    return () => { active = false; };
  }, [id, image, isGenerated, attempt]);
  if (avatar.provider === 'starter') {
    const starter = starters.find(option => option.id === avatar.starter);
    return starter && <div className="starter-portrait" data-starter={starter.id} role="img" aria-label={starter.name}>
      <starter.Icon aria-hidden="true" />
    </div>;
  }
  if (!isGenerated) return <p>Saved from the earlier sample generator.</p>;
  if (error) return <div><p role="alert">{error}</p><button type="button" className="button secondary" onClick={() => setAttempt(n => n + 1)}>Retry image</button></div>;
  if (!source) return <p role="status">Loading image…</p>;
  return <img className="avatar-portrait" src={source} alt={image === 'portrait' ? 'Generated cartoon portrait' : image + ' avatar'}
    onLoad={onLoaded} onError={() => setError('The generated image could not be displayed.')} />;
}

export function AvatarPage({ uid }: { uid: string }) {
  const [state, setState] = useState<AvatarState>();
  const [photo, setPhoto] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [generation, setGeneration] = useState<Generation>();
  const [confirmDelete, setConfirmDelete] = useState('');
  const [previewLoaded, setPreviewLoaded] = useState('');
  const [openPack, setOpenPack] = useState('');

  useEffect(() => {
    let active = true;
    void readAvatar(uid).then(value => { if (active) setState(value); })
      .catch(() => { if (active) setError('Could not load your avatars. Refresh to try again.'); });
    return () => { active = false; };
  }, [uid]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setStatus('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Something went wrong. Try again.'); }
    finally {
      setGeneration(undefined);
      setBusy(false);
    }
  }

  function generate(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setGeneration({ startedAt: performance.now(), message: 'Generating your cartoon portrait…' });
      await generateAvatar({ photo: photo.split(',')[1], consent });
      setState(await readAvatar(uid));
      setStatus('Your preview is ready.');
    });
  }

  function pickStarter(starter: StarterAvatar) {
    void run(async () => {
      await selectStarterAvatar({ starter });
      setState(await readAvatar(uid));
    });
  }

  function buildExpressions(avatar: ApprovedAvatar) {
    void run(async () => {
      setOpenPack(avatar.id);
      const pending = avatarExpressions.filter(expression => !avatar.expressions?.includes(expression));
      const startedAt = performance.now();
      const completed = avatarExpressions.length - pending.length;
      for (const [index, expression] of pending.entries()) {
        setGeneration({
          startedAt,
          avatarId: avatar.id,
          message: `Generating ${expression} expression (${completed + index + 1} of ${avatarExpressions.length})…`,
        });
        await generateAvatarExpression({ id: avatar.id, expression });
        setState(await readAvatar(uid));
      }
      setStatus('Your expression pack is ready.');
    });
  }

  function remove(id: string) {
    void run(async () => {
      await removeAvatar({ id });
      setConfirmDelete('');
      setState(await readAvatar(uid));
      setStatus('Avatar removed.');
    });
  }

  return <section className="panel avatar-page">
    <Link className="button secondary" to="/room">← Your room</Link>
    <h1>Your avatar</h1>
    <p>Choose a starter avatar for your stories.</p>
    <div className="starter-choices">
      {starters.map(starter => <button type="button" key={starter.id} className="starter-choice"
        disabled={!state || busy} aria-pressed={state?.draft?.starter === starter.id}
        onClick={() => pickStarter(starter.id)}>
        <span className="starter-portrait" data-starter={starter.id} aria-hidden="true"><starter.Icon /></span>
        {starter.name}
      </button>)}
    </div>
    <details className="divider">
      <summary className="button secondary">Use a photo</summary>
      <p>Photo portraits and expression packs require OpenAI API credits. With your consent, a resized copy goes to OpenAI. The app saves the illustration and discards the input photo.</p>
      <form onSubmit={generate}>
        <label>Choose a photo<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy}
          onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            setPhoto('');
            setConsent(false);
            void run(async () => setPhoto(await preparePhoto(file)));
          }} /></label>
        {photo && <>
          <img className="avatar-photo" src={photo} alt="Your selected photo" />
          <button type="button" className="button avatar-danger" disabled={busy} onClick={() => { setPhoto(''); setConsent(false); }}>Remove photo</button>
          <label className="avatar-consent"><input type="checkbox" checked={consent} disabled={busy}
            onChange={event => setConsent(event.target.checked)} />
            I’m the only person in this photo and consent to sending it to OpenAI to create my avatar.</label>
        </>}
        <button className="button" disabled={!state || !photo || !consent || busy}>
          {state?.draft ? 'Regenerate preview' : 'Generate preview'}
        </button>
        {generation && !generation.avatarId && <GenerationStatus {...generation} />}
      </form>
    </details>
    {state?.draft && <div className="divider">
      <h2>Avatar preview</h2>
      <AvatarImage key={state.draft.id} avatar={state.draft} onLoaded={() => setPreviewLoaded(state.draft?.id ?? '')} />
      <div className="actions">
        <button className="button" disabled={busy || (state.draft.provider !== 'starter' && previewLoaded !== state.draft.id)} onClick={() => void run(async () => {
          if (!state.draft) return;
          await approveAvatar({ id: state.draft.id });
          setPhoto('');
          setConsent(false);
          setState(await readAvatar(uid));
          setStatus('Your avatar is approved.');
        })}>Approve avatar</button>
        <button className="button avatar-danger" disabled={busy} onClick={() => state.draft && remove(state.draft.id)}>Discard preview</button>
      </div>
    </div>}
    {state && state.versions.length > 0 && <div className="divider">
      <h2>Approved avatars</h2>
      <ul>{state.versions.map(avatar => <li className="avatar-version" key={avatar.id}>
        <AvatarImage avatar={avatar} />
        <div>
          <p>Version {avatar.number}{avatar.id === state.approvedId ? ' · Current' : ''}</p>
          {avatar.provider === 'openai' && <>
            <button className="button secondary" aria-expanded={openPack === avatar.id} onClick={() => setOpenPack(openPack === avatar.id ? '' : avatar.id)}>
              Expressions ({avatar.expressions?.length ?? 0}/{avatarExpressions.length})
            </button>
            {openPack === avatar.id && <>
              <ul className="avatar-expressions">{avatarExpressions.filter(item => avatar.expressions?.includes(item)).map(expression =>
                <li key={expression}><AvatarImage avatar={avatar} image={expression} /><span>{expression}</span></li>,
              )}</ul>
              {(avatar.expressions?.length ?? 0) < avatarExpressions.length &&
                <button className="button secondary" disabled={busy} onClick={() => buildExpressions(avatar)}>
                  {avatar.expressions?.length ? 'Resume expression pack' : 'Generate expression pack'}
                </button>}
            </>}
          </>}
          {generation?.avatarId === avatar.id && <GenerationStatus {...generation} />}
          <div className="actions avatar-version-actions">
            {confirmDelete === avatar.id ? <>
              <button className="button avatar-danger" disabled={busy} onClick={() => remove(avatar.id)}>Confirm deletion</button>
              <button className="button secondary" disabled={busy} onClick={() => setConfirmDelete('')}>Cancel</button>
            </> : <button className="button avatar-danger" disabled={busy} onClick={() => setConfirmDelete(avatar.id)}>Delete version {avatar.number}</button>}
          </div>
        </div>
      </li>)}</ul>
    </div>}
    <p role="status">{status || (busy && !generation ? 'Working…' : '')}</p>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
