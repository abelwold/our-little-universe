import { useEffect, useState } from 'react';
import { collection, getCountFromServer, getDocsFromServer, limit, onSnapshot, orderBy, query, Timestamp, where } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { db } from './firebase';

type Entry = { id: string; theme: string; mood: string; review: { title: string; ending: string };
  comic?: { status: string }; favorites?: string[] };
const pageSize = 24;
const moods = ['Cute', 'Romantic', 'Flirty', 'Funny', 'Chaotic'];

function storyStreak(dates: Timestamp[]) {
  const day = 86_400_000;
  const completed = new Set(dates.map(date => Math.floor(date.toMillis() / day)));
  let current = Math.floor(Date.now() / day);
  if (!completed.has(current)) current--;
  let streak = 0;
  while (completed.has(current--)) streak++;
  return streak;
}

function StorybookRewards({ roomId, uid }: { roomId: string; uid: string }) {
  const [rewards, setRewards] = useState<{ stories: number; comics: number; favorites: number; streak: number }>();
  useEffect(() => {
    let active = true;
    const ref = collection(db, 'rooms', roomId, 'stories');
    const finished = query(ref, where('review.finalizedAt', '>', Timestamp.fromMillis(0)));
    void Promise.all([
      getCountFromServer(finished),
      getCountFromServer(query(ref, where('comic.status', '==', 'ready'))),
      getCountFromServer(query(ref, where('favorites', 'array-contains', uid))),
      getDocsFromServer(query(finished, orderBy('review.finalizedAt', 'desc'), limit(60))),
    ]).then(([stories, comics, favorites, dates]) => {
      if (active) setRewards({ stories: stories.data().count, comics: comics.data().count, favorites: favorites.data().count,
        streak: storyStreak(dates.docs.map(item => item.get('review.finalizedAt') as Timestamp)) });
    }).catch(() => { if (active) setRewards(undefined); });
    return () => { active = false; };
  }, [roomId, uid]);
  if (!rewards || !rewards.stories) return null;
  const milestones = [
    rewards.stories >= 1 && 'First Story Together',
    rewards.stories >= 5 && 'Five Adventures',
    rewards.comics >= 1 && 'First Cartoon Comic',
    rewards.favorites >= 1 && 'A Story to Keep',
  ].filter(Boolean);
  return <section className="storybook-rewards story-moment">
    <h2>Your milestones</h2>
    <p>{rewards.stories} {rewards.stories === 1 ? 'heart' : 'hearts'} earned · {rewards.streak}-day creative streak</p>
    <ul className="story-tiles">{milestones.map(milestone => <li key={String(milestone)} className="story-chip">{milestone}</li>)}</ul>
  </section>;
}

export function Storybook({ roomId, uid }: { roomId: string; uid: string }) {
  const [count, setCount] = useState(pageSize);
  const [entries, setEntries] = useState<Entry[]>();
  const [error, setError] = useState('');
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [mood, setMood] = useState('');
  const [sort, setSort] = useState<'asc' | 'desc'>('desc');

  useEffect(() => {
    const stories = collection(db, 'rooms', roomId, 'stories');
    return onSnapshot(query(stories, ...(favoritesOnly ? [where('favorites', 'array-contains', uid)] : []),
      ...(mood ? [where('mood', '==', mood)] : []), orderBy('scene.completedAt', sort), limit(count)), snapshot => {
      setEntries(snapshot.docs.map(item => ({ id: item.id, ...item.data() }) as Entry));
      setError('');
    }, () => setError('Could not open this storybook. Check your access and try again.'));
  }, [roomId, count, favoritesOnly, uid, mood, sort]);

  return <section className="panel story-panel">
    <Link className="quiet" to="/room">← Your room</Link>
    <h1>Our storybook</h1>
    <StorybookRewards roomId={roomId} uid={uid} />
    <div className="story-settings">
      <label>Mood<select aria-label="Filter by mood" value={mood} onChange={event => {
        setMood(event.target.value); setEntries(undefined); setCount(pageSize);
      }}><option value="">All moods</option>{moods.map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Sort<select aria-label="Sort stories" value={sort} onChange={event => {
        setSort(event.target.value === 'asc' ? 'asc' : 'desc'); setEntries(undefined); setCount(pageSize);
      }}><option value="desc">Newest first</option><option value="asc">Oldest first</option></select></label>
    </div>
    <button className="button secondary" aria-pressed={favoritesOnly} onClick={() => {
      setFavoritesOnly(!favoritesOnly);
      setCount(pageSize);
      setEntries(undefined);
    }}>My favorites</button>
    {error ? <p className="error" role="alert">{error}</p>
      : !entries ? <p role="status">Opening your storybook…</p>
      : !entries.length ? <p>{mood || favoritesOnly ? 'No illustrated stories match these filters.' : 'Your illustrated stories will appear here.'}</p>
      : <>
        <ul className="storybook-grid">
          {entries.map(entry => <li key={entry.id} className="story-moment storybook-entry">
            <strong>{entry.favorites?.includes(uid) && '★ '}{entry.theme} · {entry.mood}</strong>
            <h2>{entry.review.title}</h2>
            <p>{entry.review.ending}</p>
            <Link className="quiet" to={'/story?room=' + roomId + '&story=' + entry.id}>
              {entry.comic?.status === 'ready' ? 'Open postcard & comic ↗' : 'Open illustrated story ↗'}
            </Link>
          </li>)}
        </ul>
        {entries.length === count && <button className="button secondary" onClick={() => setCount(count + pageSize)}>Show more</button>}
      </>}
  </section>;
}
