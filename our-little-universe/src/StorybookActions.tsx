import { useState } from 'react';
import { updateStorybookActivity, type StorybookActivity, type StoryReaction } from './firebase';

const reactions: { key: StoryReaction; label: string }[] = [
  { key: 'love', label: '❤️ Love it' }, { key: 'funny', label: '😂 Made me laugh' },
  { key: 'sweet', label: '🥹 So sweet' }, { key: 'flirty', label: '🔥 Flirty' },
];

export function StorybookActions({ roomId, storyId, uid, activity }: {
  roomId: string; storyId: string; uid: string; activity: StorybookActivity;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const favorite = activity.favorites?.includes(uid) ?? false;
  const mine = activity.reactions?.find(item => item.uid === uid)?.reaction;
  const partner = reactions.find(option => activity.reactions?.some(item => item.uid !== uid && item.reaction === option.key));

  async function save(change: { kind: 'favorite'; selected: boolean } |
    { kind: 'reaction'; reaction: StoryReaction | null }) {
    setBusy(true);
    setError('');
    try { await updateStorybookActivity({ roomId, storyId, ...change }); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not update your storybook.'); }
    finally { setBusy(false); }
  }

  return <section className="divider story-scene">
    <h2>Reactions</h2>
    <div className="actions" aria-label="Story reactions">
      {reactions.map(option => <button key={option.key} className="story-chip" aria-pressed={mine === option.key}
        disabled={busy} onClick={() => void save({ kind: 'reaction', reaction: mine === option.key ? null : option.key })}>
        {option.label}
      </button>)}
    </div>
    {partner && <p role="status">Your partner reacted {partner.label}.</p>}
    <button className="quiet" aria-pressed={favorite} disabled={busy}
      onClick={() => void save({ kind: 'favorite', selected: !favorite })}>{favorite ? '★ Remove from favorites' : '☆ Add to favorites'}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
