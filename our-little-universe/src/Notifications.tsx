import { useEffect, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, updateDoc, type Timestamp } from 'firebase/firestore';
import { Link } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { db } from './firebase';

type Notice = { id: string; message: string; roomId: string; storyId?: string; read: boolean; createdAt?: Timestamp };

export function Notifications({ uid }: { uid: string }) {
  const [entries, setEntries] = useState<Notice[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [showBadge, setShowBadge] = useState(true);
  useEffect(() => onSnapshot(doc(db, 'preferences', uid),
    snapshot => setShowBadge(snapshot.data()?.notificationBadge !== false), () => setShowBadge(true)), [uid]);

  useEffect(() => onSnapshot(query(collection(db, 'players', uid, 'notifications'),
    orderBy('createdAt', 'desc'), limit(40)), snapshot => {
    setEntries(snapshot.docs.map(item => ({ ...item.data(), id: item.id }) as Notice));
    setError('');
  }, () => setError('Could not load notifications.')), [uid]);

  const unread = showBadge ? entries.filter(entry => !entry.read).length : 0;
  async function markRead(entry: Notice) {
    if (entry.read) return;
    try { await updateDoc(doc(db, 'players', uid, 'notifications', entry.id), { read: true }); }
    catch { setError('Could not mark this notification as read.'); }
  }

  return <details className="notifications" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary aria-label={unread ? 'Notifications, ' + unread + ' unread' : 'Notifications'}>
      <Bell size={18} aria-hidden="true" />{unread ? <span aria-hidden="true">{unread}</span> : null}
    </summary>
    <div className="notification-panel">
      <h2>Notifications</h2>
      {error && <p role="alert">{error}</p>}
      {!entries.length && !error && <p>You’re all caught up.</p>}
      <ul>{entries.map(entry => <li key={entry.id} className={entry.read ? '' : 'unread-notice'}>
        <Link to={entry.storyId ? '/story?room=' + entry.roomId + '&story=' + entry.storyId : '/room'}
          onClick={() => { void markRead(entry); setOpen(false); }}>{entry.message}</Link>
        {entry.createdAt && <time dateTime={entry.createdAt.toDate().toISOString()}>
          {new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(entry.createdAt.toDate())}
        </time>}
      </li>)}</ul>
    </div>
  </details>;
}
