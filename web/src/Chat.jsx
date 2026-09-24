import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from './api.js';
import { ErrorNote, useAction } from './ui.jsx';

// In-app chat + masked call (no phone numbers are ever shown).
export default function Chat({ bookingId, me }) {
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [notice, setNotice] = useState(null);
  const { busy, error, run } = useAction();
  const endRef = useRef(null);

  useEffect(() => {
    let alive = true;
    const load = () => api(`/bookings/${bookingId}/messages`).then((d) => alive && setMessages(d.messages)).catch(() => {});
    load();
    const t = setInterval(load, 10000);
    return () => { alive = false; clearInterval(t); };
  }, [bookingId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length]);

  const send = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api(`/bookings/${bookingId}/messages`, { method: 'POST', body: { body: text } });
      setMessages((m) => [...m, r.message]);
      setText('');
      setNotice(r.notice);
    });
  };

  const call = () => run(async () => {
    const r = await api(`/bookings/${bookingId}/call`, { method: 'POST' });
    setNotice(r.message);
  });

  return (
    <div className="card">
      <div className="row between">
        <h2 style={{ margin: 0 }}>Chat</h2>
        <button type="button" className="btn sm" onClick={call} disabled={busy}>📞 Masked call</button>
      </div>
      <p className="small muted">Your number stays private. Keep all communication in the app.</p>
      <div className="chat" aria-live="polite">
        {messages.length === 0 && <p className="small muted center">No messages yet.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`bubble ${m.sender_role === me ? 'me' : ''}`} title={fmtDateTime(m.created_at)}>{m.body}</div>
        ))}
        <div ref={endRef} />
      </div>
      {notice && <div className="banner info small mt">{notice}</div>}
      <ErrorNote error={error} />
      <form className="row mt" onSubmit={send}>
        <input className="grow" value={text} onChange={(e) => setText(e.target.value)} placeholder="Message" maxLength={1000} aria-label="Message" />
        <button className="btn primary" disabled={busy || !text.trim()}>Send</button>
      </form>
    </div>
  );
}
