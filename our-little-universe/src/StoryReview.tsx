import { useEffect, useState, type FormEvent } from 'react';
import { generateStoryDraft, reviewStory, type AiDraftStatus } from './firebase';

export type Review = {
  title: string;
  narrative: string;
  ending: string;
  revision: number;
  approvals: string[];
  finalizedAt?: unknown;
};
type Draft = Pick<Review, 'title' | 'narrative' | 'ending' | 'revision'>;

const endings = [
  ['Cute', 'They lingered a little longer, hoping the moment would last.'],
  ['Funny', 'They laughed so hard they forgot who was supposed to deliver the final line.'],
  ['Flirty', 'They said goodnight, then found one more excuse to stay.'],
] as const;

export function StoryReview({ roomId, storyId, uid, review, aiDraft, aiConsents = [] }: {
  roomId: string; storyId: string; uid: string; review?: Review; aiDraft?: AiDraftStatus; aiConsents?: string[];
}) {
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changed = !!draft && draft.revision !== review?.revision;
  const final = !!review?.finalizedAt;
  const approved = review?.approvals.includes(uid);
  const [expiredToken, setExpiredToken] = useState('');
  const aiToken = aiDraft?.token;
  const aiExpiresAt = aiDraft?.expiresAt;
  useEffect(() => {
    if (!aiToken || !aiExpiresAt) return;
    const timer = window.setTimeout(() => setExpiredToken(aiToken), Math.max(0, aiExpiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [aiToken, aiExpiresAt]);
  const interpreting = aiDraft?.status === 'generating' && aiToken !== expiredToken;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : 'Could not save the story. Try again.'); }
    finally { setBusy(false); }
  }

  function edit() {
    if (!review) return;
    const { title, narrative, ending, revision } = review;
    setDraft({ title, narrative, ending, revision });
    setError('');
  }

  function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || changed || busy) return;
    void run(async () => {
      await reviewStory({ roomId, storyId, action: 'save', ...draft });
      setDraft(undefined);
    });
  }

  return <section className="divider story-review">
    <h2>{final ? 'Your finished story' : 'Review your story'}</h2>
    {!review ? <>
      <p>Start with a draft built from your captions and tiles.</p>
      <button className="button" disabled={busy} onClick={() => void run(() => reviewStory({ roomId, storyId, action: 'draft' }))}>
        {busy ? 'Working…' : 'Create story draft'}
      </button>
    </> : draft && !final ? <form onSubmit={save}>
      <label>Story title<input required maxLength={100} value={draft.title} disabled={busy}
        onChange={event => setDraft({ ...draft, title: event.target.value })} /></label>
      <label>Story text<textarea aria-label="Story text" required maxLength={4000} rows={7} value={draft.narrative} disabled={busy}
        onChange={event => setDraft({ ...draft, narrative: event.target.value })} /></label>
      <div className="actions">
        {endings.map(([label, text]) => <button key={label} type="button" className="story-chip" disabled={busy}
          onClick={() => setDraft({ ...draft, ending: text })}>{label} ending</button>)}
      </div>
      <label>Ending<textarea aria-label="Ending" maxLength={400} rows={3} value={draft.ending} disabled={busy}
        onChange={event => setDraft({ ...draft, ending: event.target.value })} /></label>
      {changed && <p className="error" role="alert">Your partner saved a newer draft. Copy any edits you want to keep, then load the latest version.</p>}
      <div className="actions">
        <button className="button" disabled={busy || changed}>Save draft</button>
        {changed && <button className="quiet" type="button" disabled={busy} onClick={edit}>Load latest draft</button>}
        <button className="quiet" type="button" disabled={busy} onClick={() => { setDraft(undefined); setError(''); }}>Cancel</button>
      </div>
    </form> : <>
      <article className="story-moment story-prose">
        <h3>{review.title}</h3>
        <p>{review.narrative}</p>
        {review.ending && <div className="divider"><strong>Ending</strong><p>{review.ending}</p></div>}
      </article>
      <p role="status">{final ? 'Approved by both of you.' : approved ? 'You approved. Waiting for your partner.'
        : review.approvals.length ? 'Your partner approved. This version is ready for your approval.'
        : 'Both players need to approve the same version.'}</p>
      {!final && <div className="actions">
        <button className="button secondary" disabled={busy} onClick={edit}>Edit story and ending</button>
        <button className="button" disabled={busy || approved || !review.ending} onClick={() =>
          void run(() => reviewStory({ roomId, storyId, action: 'approve', revision: review.revision }))}>Approve story</button>
      </div>}
    </>}
    {!final && !draft && <details className="divider">
      <summary>Write with AI</summary>
      <p>With both players’ approval, send your emoji timeline and captions to OpenAI to write an editable draft.</p>
      <div className="actions">
        <button className="button secondary" disabled={busy} aria-pressed={aiConsents.includes(uid)} onClick={() =>
          void run(() => reviewStory({ roomId, storyId, action: 'ai-consent', allowed: !aiConsents.includes(uid) }))}>
          {aiConsents.includes(uid) ? 'Withdraw my permission' : 'Allow AI drafting'}
        </button>
        <button className="button" disabled={busy || interpreting || aiConsents.length < 2}
          onClick={() => void run(() => generateStoryDraft({ roomId, storyId }))}>
          {review ? 'Replace with AI draft' : 'Generate AI draft'}
        </button>
      </div>
      <p role="status">{interpreting ? 'Writing your draft…' : aiConsents.length === 2 ? 'Both players have agreed.' : 'Both players must allow AI drafting.'}</p>
      {aiDraft?.message && !error && <p className="error" role="alert">{aiDraft.message}</p>}
    </details>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
