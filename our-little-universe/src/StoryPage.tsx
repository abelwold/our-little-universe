import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { doc, onSnapshot, type Timestamp } from 'firebase/firestore';
import { Link, useNavigate } from 'react-router-dom';
import { db, playStoryTurn, startStory, type StoryTile } from './firebase';
import { StoryReview, type Review } from './StoryReview';
import { StoryComic, StoryScene } from './StoryScene';
import { StorybookActions } from './StorybookActions';
import type { AiDraftStatus, Scene, SceneConsent, StorybookActivity } from './firebase';

const themes = ['First Date', 'Movie Night', 'Surprise Visit', 'Long-Distance Reunion', 'Dream Vacation', 'Cozy Night',
  'Rainy Day Romance', 'Mystery Date', 'Flirty Chaos', 'How We Met', 'Dream Future', 'Random Adventure'];
const moods = ['Cute', 'Romantic', 'Flirty', 'Funny', 'Chaotic'];
const palette = {
  Feelings: ['💕', '🥰', '😂', '😍', '🥹', '😏', '💋', '😳', '✨', '❤️'],
  Places: ['🏠', '🌃', '🏖️', '🏕️', '🏰', '🎡', '🏝️', '🗼'],
  Food: ['☕', '🍕', '🍓', '🍰', '🍿', '🥐', '🍦', '🍜'],
  Activities: ['🎬', '🎮', '🎤', '🎨', '🎵', '🎁', '💌', '📸'],
  Travel: ['🚗', '✈️', '🚆', '🛶', '🗺️', '🧳', '🚲', '🚀'],
  Nature: ['🌙', '🌧️', '☀️', '🌈', '🌹', '🌊', '🌿', '⭐'],
};
const actions = { Wave: '👋', Dance: '💃', 'Give flowers': '💐', 'Hold hands': '🤝', Hug: '🫂' };
const starters = { moon: '🌙', sun: '☀️', comet: '☄️', planet: '🪐' };

type Turn = { uid: string; tiles: StoryTile[]; caption: string };
type Story = StorybookActivity & {
  theme: string; mood: string; rounds: number; nextPlayer: string | null; status: 'playing' | 'complete';
  turns: Turn[]; review?: Review; scene?: Scene; comic?: Scene; sceneConsents?: SceneConsent[];
  completedAt?: Timestamp; createdAt?: Timestamp;
  aiDraft?: AiDraftStatus; aiDraftConsents?: string[];
  origin?: { mode: 'continue' | 'remix'; title: string; ending?: string };
};
type Room = { title: string; status: 'waiting' | 'ready'; activeStoryId?: string };

function errorText(error: unknown) {
  return error instanceof Error ? error.message : 'Something went wrong. Try again.';
}

function Setup({ roomId, previousId, source }: { roomId: string; previousId: string | null;
  source?: { storyId: string; mode: 'continue' | 'remix'; theme: string; mood: string; rounds: number };
}) {
  const [theme, setTheme] = useState(source?.theme ?? themes[0]);
  const [mood, setMood] = useState(source?.mood ?? moods[0]);
  const [rounds, setRounds] = useState(source?.rounds ?? 5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await startStory({ roomId, previousId, theme, mood, rounds,
        ...(source ? { origin: { storyId: source.storyId, mode: source.mode } } : {}) });
      if (source) navigate('/story?room=' + roomId);
    }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <form className="divider" onSubmit={submit}>
    {!previousId && <h2>Start a story</h2>}
    <div className="story-settings">
      <label>Theme<select aria-label="Theme" value={theme} onChange={event => setTheme(event.target.value)}>
        {themes.map(item => <option key={item}>{item}</option>)}
      </select></label>
      <label>Mood<select aria-label="Mood" value={mood} onChange={event => setMood(event.target.value)}>
        {moods.map(item => <option key={item}>{item}</option>)}
      </select></label>
      <label>Turns per person<select aria-label="Turns per person" value={rounds} onChange={event => setRounds(Number(event.target.value))}>
        {[3, 5, 7].map(number => <option key={number} value={number}>{number} each · {number * 2} total</option>)}
      </select></label>
    </div>
    <button className="button" disabled={busy}>{busy ? 'Starting…' : source?.mode === 'continue' ? 'Start next chapter' : source ? 'Start remix' : 'Start story'}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

function tileLabel(tile: StoryTile, isMine: boolean) {
  if (tile.kind === 'emoji') return tile.value;
  if (tile.kind === 'action') return actions[tile.value as keyof typeof actions] + ' ' + tile.value;
  const symbol = tile.starter ? starters[tile.starter] : '👤';
  return symbol + (isMine ? ' Me' : ' Partner');
}

function Composer({ roomId, storyId, turnNumber }: { roomId: string; storyId: string; turnNumber: number }) {
  const [category, setCategory] = useState<keyof typeof palette>('Feelings');
  const [tiles, setTiles] = useState<StoryTile[]>([]);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef<string | null>(null);
  function add(tile: StoryTile) {
    setTiles(current => current.length < 3 ? [...current, tile] : current);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!tiles.length || busy) return;
    requestId.current ??= crypto.randomUUID();
    setBusy(true);
    setError('');
    try { await playStoryTurn({ roomId, storyId, turnNumber, requestId: requestId.current, tiles, caption }); }
    catch (error) { setError(errorText(error)); }
    finally { setBusy(false); }
  }
  return <form className="divider" onSubmit={submit}>
    <h2>Add your turn</h2>
    <p>Choose up to three tiles. Tap a selected tile to remove it.</p>
    <div className="story-tiles" aria-label="Selected tiles">
      {tiles.map((tile, index) => <button className="story-chip" key={index} type="button" disabled={busy}
        aria-label={'Remove ' + tileLabel(tile, true)} onClick={() => setTiles(current => current.filter((_, position) => position !== index))}>{tileLabel(tile, true)} ×</button>)}
    </div>
    <label>Emoji category<select aria-label="Emoji category" value={category} onChange={event => setCategory(event.target.value as keyof typeof palette)}>
      {Object.keys(palette).map(item => <option key={item}>{item}</option>)}
    </select></label>
    <div className="story-tiles" aria-label="Emoji picker">
      {palette[category].map(value => <button className="story-chip story-emoji" type="button" key={value}
        disabled={busy || tiles.length >= 3} onClick={() => add({ kind: 'emoji', value })}>{value}</button>)}
    </div>
    <div className="story-tiles story-actions" aria-label="Avatar and action tiles">
      <button type="button" className="story-chip" disabled={busy || tiles.length >= 3}
        onClick={() => add({ kind: 'avatar', value: 'me' })}>👤 My avatar</button>
      {Object.keys(actions).map(value => <button className="story-chip" type="button" key={value}
        disabled={busy || tiles.length >= 3} onClick={() => add({ kind: 'action', value })}>{tileLabel({ kind: 'action', value }, true)}</button>)}
    </div>
    <label>Caption (optional)<textarea value={caption} onChange={event => setCaption(event.target.value)} rows={2}
      maxLength={180} disabled={busy} placeholder="What happened next?" /></label>
    <button className="button" disabled={!tiles.length || busy}>{busy ? 'Sending…' : 'Send turn'}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </form>;
}

export function StoryPage({ uid, roomId, savedStoryId }: { uid: string; roomId: string; savedStoryId?: string }) {
  const [room, setRoom] = useState<Room>();
  const [active, setActive] = useState<{ id: string; story: Story }>();
  const [roomError, setRoomError] = useState('');
  const [storyError, setStoryError] = useState('');
  const activeId = savedStoryId ?? room?.activeStoryId;

  useEffect(() => onSnapshot(doc(db, 'rooms', roomId), snapshot => {
    if (snapshot.exists()) setRoom(snapshot.data() as Room);
    else setRoomError('This room is unavailable.');
  }, () => setRoomError('Could not open this room. Check your membership and connection.')), [roomId]);

  useEffect(() => {
    setStoryError('');
    if (activeId) return onSnapshot(doc(db, 'rooms', roomId, 'stories', activeId), snapshot => {
      if (snapshot.exists()) setActive({ id: activeId, story: snapshot.data() as Story });
      else setStoryError('This story is unavailable.');
    }, () => setStoryError('Could not load the story. Check your connection and refresh.'));
  }, [roomId, activeId]);

  const story = active?.id === activeId ? active?.story : undefined;
  const total = story ? story.rounds * 2 : 0;
  const complete = story?.status === 'complete';
  const playedAt = story?.completedAt ?? story?.createdAt;
  const playedDate = playedAt ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long', timeZone: 'UTC' }).format(playedAt.toDate()) : '';
  return <section className="panel story-panel">
    <div className="actions">
      <Link className="quiet" to="/room">← Your room</Link>
      <Link className="quiet" to={'/storybook?room=' + roomId}>Storybook</Link>
    </div>
    <h1>{story?.theme ?? 'Your story'}</h1>
    {story?.origin && <aside className="story-moment">
      <strong>{story.origin.mode === 'continue' ? 'Continuing' : 'Remixing'} {story.origin.title}</strong>
      {story.origin.ending && <p>{story.origin.ending}</p>}
    </aside>}
    {roomError ? <p className="error" role="alert">{roomError}</p>
      : !room ? <p role="status">Opening your room…</p>
      : room.status !== 'ready' ? <p>Invite your partner to start a story together.</p>
      : !activeId ? <Setup roomId={roomId} previousId={null} />
      : storyError ? <p className="error" role="alert">{storyError}</p>
      : !story ? <p role="status">Opening story…</p>
      : <>
        <div className="story-meta">
          <span>{story.mood}</span>
          <span>{story.turns.length} of {total} turns</span>
        </div>
        <progress aria-label="Story progress" max={total} value={story.turns.length} />
        <p role="status" className="story-turn-status">{complete ? 'Story complete' : story.nextPlayer === uid ? 'Your turn' : 'Your partner’s turn'}</p>
        <ol className="story-timeline" aria-label="Story timeline">
          {story.turns.map((turn, index) => <li key={index} className="story-moment">
            <strong>{turn.uid === uid ? 'You' : 'Partner'}</strong>
            <div className="story-tiles">{turn.tiles.map((tile, position) =>
              <span key={position} className={tile.kind === 'emoji' ? 'story-chip story-emoji' : 'story-chip'}>{tileLabel(tile, turn.uid === uid)}</span>)}</div>
            {turn.caption && <p>{turn.caption}</p>}
          </li>)}
        </ol>
        {complete ? <>
          <StoryReview key={activeId} uid={uid} roomId={roomId} storyId={activeId} review={story.review}
            aiDraft={story.aiDraft} aiConsents={story.aiDraftConsents} />
          {story.review?.finalizedAt ? <StoryScene key={'scene-' + activeId} uid={uid} roomId={roomId} storyId={activeId}
            title={story.review.title} date={playedDate} scene={story.scene} consents={story.sceneConsents ?? []} /> : null}
          {story.review?.finalizedAt && story.scene?.status === 'ready' ? <StoryComic key={'comic-' + activeId}
            roomId={roomId} storyId={activeId} title={story.review.title} date={playedDate} comic={story.comic} /> : null}
          {story.scene?.status === 'ready' && <StorybookActions key={'activity-' + activeId}
            roomId={roomId} storyId={activeId} uid={uid} activity={story} />}
          {story.review?.finalizedAt && (['continue', 'remix'] as const).map(mode =>
            <details key={mode + activeId} className="divider"><summary>{mode === 'continue' ? 'Continue this story' : 'Remix this story'}</summary>
              <Setup roomId={roomId} previousId={room.activeStoryId ?? null}
                source={{ storyId: activeId, mode, theme: story.theme, mood: story.mood, rounds: story.rounds }} />
            </details>,
          )}
          {!savedStoryId && <details className="divider"><summary>Start another story</summary>
            <Setup key={activeId} roomId={roomId} previousId={activeId} />
          </details>}
        </>
          : story.nextPlayer === uid ? <Composer key={activeId + story.turns.length} roomId={roomId} storyId={activeId} turnNumber={story.turns.length} />
          : <p>Check back when your partner has added their turn.</p>}
      </>}
  </section>;
}
