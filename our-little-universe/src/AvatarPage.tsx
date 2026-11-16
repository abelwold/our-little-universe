import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { doc, collection, getDocFromServer, getDocsFromServer, orderBy, query } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import {
  approveAvatar, avatarExpressions, db, generateAvatar, generateAvatarExpression, getAvatarImage, removeAvatar, selectStarterAvatar,
  type AvatarExpression, type AvatarPreview, type StarterAvatar,
} from './firebase';

type ApprovedAvatar = AvatarPreview & { number: number };
type AvatarState = { draft?: AvatarPreview; approvedId?: string; versions: ApprovedAvatar[] };
const starters = [
  { id: 'moon', name: 'Moon', symbol: '🌙' },
  { id: 'sun', name: 'Sun', symbol: '☀️' },
  { id: 'comet', name: 'Comet', symbol: '☄️' },
  { id: 'planet', name: 'Saturn', symbol: '🪐' },
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
    return starter && <div className="starter-portrait" data-starter={starter.id} role="img" aria-label={starter.name}>{starter.symbol}</div>;
  }
  if (!isGenerated) return <p>Saved from the earlier sample generator.</p>;
  if (error) return <div><p role="alert">{error}</p><button className="quiet" onClick={() => setAttempt(n => n + 1)}>Retry image</button></div>;
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
    finally { setBusy(false); }
  }

  function generate(event: FormEvent) {
    event.preventDefault();
    void run(async () => {
      setStatus('Generating your cartoon portrait…');
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
      for (const expression of pending) {
        setStatus('Generating ' + expression + ' expression…');
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

  return <section className="panel">
    <Link className="quiet" to="/room">← Your room</Link>
    <h1>Your avatar</h1>
    <p>Choose a starter avatar for your stories.</p>
    <div className="starter-choices">
      {starters.map(starter => <button type="button" key={starter.id} className="starter-choice"
        disabled={!state || busy} aria-pressed={state?.draft?.starter === starter.id}
        onClick={() => pickStarter(starter.id)}>
        <span className="starter-portrait" data-starter={starter.id} aria-hidden="true">{starter.symbol}</span>
        {starter.name}
      </button>)}
    </div>
    <details className="divider">
      <summary>Use a photo later</summary>
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
          <button type="button" className="quiet" disabled={busy} onClick={() => { setPhoto(''); setConsent(false); }}>Remove photo</button>
          <label className="avatar-consent"><input type="checkbox" checked={consent} disabled={busy}
            onChange={event => setConsent(event.target.checked)} />
            I’m the only person in this photo and consent to sending it to OpenAI to create my avatar.</label>
        </>}
        <button className="button" disabled={!state || !photo || !consent || busy}>
          {state?.draft ? 'Regenerate preview' : 'Generate preview'}
        </button>
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
        <button className="quiet" disabled={busy} onClick={() => state.draft && remove(state.draft.id)}>Discard preview</button>
      </div>
    </div>}
    {state && state.versions.length > 0 && <div className="divider">
      <h2>Approved avatars</h2>
      <ul>{state.versions.map(avatar => <li className="avatar-version" key={avatar.id}>
        <AvatarImage avatar={avatar} />
        <div>
          <p>Version {avatar.number}{avatar.id === state.approvedId ? ' · Current' : ''}</p>
          {avatar.provider === 'openai' && <>
            <button className="quiet" aria-expanded={openPack === avatar.id} onClick={() => setOpenPack(openPack === avatar.id ? '' : avatar.id)}>
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
          {confirmDelete === avatar.id ? <div className="actions">
            <button className="quiet" disabled={busy} onClick={() => remove(avatar.id)}>Confirm deletion</button>
            <button className="quiet" disabled={busy} onClick={() => setConfirmDelete('')}>Cancel</button>
          </div> : <button className="quiet" disabled={busy} onClick={() => setConfirmDelete(avatar.id)}>Delete version {avatar.number}</button>}
        </div>
      </li>)}</ul>
    </div>}
    <p role="status">{status || (busy ? 'Working…' : '')}</p>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
