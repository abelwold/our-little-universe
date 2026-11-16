import { useEffect, useRef, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { avatarExpressions, db, generateScene, getSceneImage, setSceneConsent, type AvatarExpression, type Scene, type SceneConsent } from './firebase';

type SceneProps = { roomId: string; storyId: string };

function downloadArtwork(photo: HTMLImageElement, title: string, date: string, format: 'scene' | 'comic') {
  const width = 1120;
  const inset = 48;
  const artwork = width - inset * 2;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  const ctx = canvas.getContext('2d');
  if (!ctx || !photo.naturalWidth) throw new Error('The postcard image is still loading.');

  const titleFont = 'bold 59px Georgia';
  ctx.font = titleFont;
  const lines: string[] = [];
  let line = '';
  for (const word of title.split(/\s+/)) {
    const next = line ? line + ' ' + word : word;
    if (line && ctx.measureText(next).width > artwork) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  const artHeight = Math.round(artwork * photo.naturalHeight / photo.naturalWidth);
  const footer = inset + artHeight + 44;
  canvas.height = footer + lines.length * 70 + (date ? 110 : 55);

  ctx.fillStyle = '#fff4e0';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(photo, inset, inset, artwork, artHeight);
  ctx.fillStyle = '#38213f';
  ctx.font = titleFont;
  ctx.textAlign = 'center';
  lines.forEach((text, index) => ctx.fillText(text, width / 2, footer + 50 + index * 70, artwork));
  if (date) {
    ctx.fillStyle = '#72546e';
    ctx.font = '28px system-ui';
    ctx.fillText('Played ' + date, width / 2, footer + lines.length * 70 + 48, artwork);
  }
  const link = document.createElement('a');
  link.href = canvas.toDataURL('image/png');
  link.download = format === 'comic' ? 'our-little-universe-comic.png' : 'our-little-universe-postcard.png';
  link.click();
}

export function SceneImage({ roomId, storyId, title, date, format = 'scene' }: SceneProps & {
  title: string; date: string; format?: 'scene' | 'comic';
}) {
  const [source, setSource] = useState('');
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [downloadError, setDownloadError] = useState('');
  const photo = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let active = true;
    setError(false);
    setSource('');
    void getSceneImage({ roomId, storyId, format }).then(({ data }) => {
      if (active) setSource('data:image/jpeg;base64,' + data.jpeg);
    }).catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [roomId, storyId, attempt, format]);

  if (error) return <div><p role="alert">Could not load the illustration.</p>
    <button className="quiet" onClick={() => setAttempt(value => value + 1)}>Retry image</button></div>;
  if (!source) return <p role="status">Loading illustration…</p>;
  return <>
    <figure className={'scene-image postcard' + (format === 'comic' ? ' comic-page' : '')}>
      <img ref={photo} src={source} alt={(format === 'comic' ? 'Three-panel comic for ' : 'Storybook illustration for ') + title} onError={() => setError(true)} />
      <figcaption><h3>{title}</h3>{date && <p>Played {date}</p>}</figcaption>
    </figure>
    <button className="quiet" onClick={() => {
      if (!photo.current) return;
      try { downloadArtwork(photo.current, title, date, format); setDownloadError(''); }
      catch { setDownloadError('Could not download the image. Try again once it has loaded.'); }
    }}>{format === 'comic' ? 'Download comic' : 'Download postcard'}</button>
    {downloadError && <p className="error" role="alert">{downloadError}</p>}
  </>;
}

function useGenerationStatus(scene?: Scene) {
  const [expiredAttempt, setExpiredAttempt] = useState('');
  const expiresAt = scene?.expiresAt;
  const attempt = scene?.attempt;
  useEffect(() => {
    if (scene?.status !== 'generating' || !attempt || !expiresAt) return;
    const timer = window.setTimeout(() => setExpiredAttempt(attempt), Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [scene?.status, attempt, expiresAt]);
  return {
    working: scene?.status === 'generating' && expiredAttempt !== scene.attempt,
    retry: scene?.status === 'failed' || (!!expiredAttempt && expiredAttempt === scene?.attempt),
  };
}

export function StoryComic({ roomId, storyId, title, date, comic }: SceneProps & {
  title: string; date: string; comic?: Scene;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { working, retry } = useGenerationStatus(comic);

  async function generate() {
    setBusy(true);
    setError('');
    try { await generateScene({ roomId, storyId, format: 'comic' }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not generate the comic. Try again.'); }
    finally { setBusy(false); }
  }

  return <section className="divider story-scene">
    <h2>Three-panel comic</h2>
    {comic?.status === 'ready'
      ? <SceneImage roomId={roomId} storyId={storyId} title={title} date={date} format="comic" />
      : working ? <p role="status">Creating your comic. You can come back to it later.</p>
      : <>
        <p>Uses the approved story and the characters you chose for the postcard. Generating uses API credits.</p>
        <button type="button" className="button secondary" disabled={busy} onClick={() => void generate()}>
          {busy ? 'Starting…' : retry ? 'Retry comic' : 'Generate comic'}
        </button>
        {(error || comic?.message) && <p className="error" role="alert">{error || comic?.message}</p>}
      </>}
  </section>;
}

export function StoryScene({ roomId, storyId, uid, title, date, scene, consents }: SceneProps & {
  uid: string; title: string; date: string; scene?: Scene; consents: SceneConsent[];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { working, retry } = useGenerationStatus(scene);

  const mine = consents.find(consent => consent.uid === uid);
  const both = consents.length === 2;
  const selectedVersionId = mine?.versionId;
  const [pack, setPack] = useState<{ versionId: string; expressions: AvatarExpression[] }>();
  useEffect(() => {
    if (!selectedVersionId || working || scene?.status === 'ready') return;
    return onSnapshot(doc(db, 'avatars', uid, 'versions', selectedVersionId), snapshot => {
      const data = snapshot.data();
      setPack({ versionId: selectedVersionId, expressions: avatarExpressions.filter(
        expression => data?.provider === 'openai' && data.expressions?.includes(expression),
      ) });
    }, () => setPack(undefined));
  }, [uid, selectedVersionId, scene?.status, working]);
  const savedExpressions = pack?.versionId === selectedVersionId ? pack?.expressions : undefined;
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update the illustration. Try again.'); }
    finally { setBusy(false); }
  }

  function choose(choice: 'avatar' | 'fictional' | 'withdraw') {
    void run(() => setSceneConsent({ roomId, storyId, choice }));
  }

  return <section className="divider story-scene">
    <h2>{scene?.status === 'ready' ? 'Your illustrated reveal' : 'Illustrate your story'}</h2>
    {scene?.status === 'ready' ? <>
      <SceneImage roomId={roomId} storyId={storyId} title={title} date={date} />
      <p>Saved in your private storybook.</p>
    </> : working ? <p role="status">Creating your illustration. You can come back to it later.</p> : <>
      <p>Both partners choose how to appear. Generating sends your approved story and any selected photo-based avatar illustrations to OpenAI and uses API credits.</p>
      <div className="actions">
        <button type="button" disabled={busy} aria-pressed={!!mine?.versionId} className="button secondary"
          onClick={() => choose('avatar')}>Use my approved avatar</button>
        <button type="button" disabled={busy} aria-pressed={!!mine && !mine.versionId} className="button secondary"
          onClick={() => choose('fictional')}>Use a fictional character</button>
        {mine && <button type="button" disabled={busy} className="quiet" onClick={() => choose('withdraw')}>Withdraw consent</button>}
      </div>
      {selectedVersionId && !!savedExpressions?.length && <label>My expression for this scene
        <select aria-label="My expression for this scene" value={mine?.expression ?? ''} disabled={busy}
          onChange={event => {
            const expression = (event.target.value || null) as AvatarExpression | null;
            void run(() => setSceneConsent({ roomId, storyId, choice: 'avatar', selectedVersionId, expression }));
          }}>
          <option value="">Original portrait</option>
          {savedExpressions.map(expression => <option key={expression} value={expression}>
            {expression[0].toUpperCase() + expression.slice(1)}
          </option>)}
        </select>
      </label>}
      <p role="status">{both ? 'Both players are ready.' : mine ? 'Waiting for your partner to choose.' : 'Choose how you want to appear.'}</p>
      <button className="button" disabled={busy || !both} onClick={() => void run(() => generateScene({ roomId, storyId }))}>
        {retry ? 'Retry illustration' : 'Generate illustration'}
      </button>
      {(error || scene?.message) && <p className="error" role="alert">{error || scene?.message}</p>}
    </>}
  </section>;
}
