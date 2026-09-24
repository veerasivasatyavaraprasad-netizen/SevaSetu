import { useState } from 'react';
import { api } from '../../api.js';
import { ErrorNote, Loading, useAction, useApi } from '../../ui.jsx';

// Section 3.2: training / policy acknowledgement (anti-cash sign-off).
export function PolicyAccept({ onAccepted, accepted }) {
  const [policy] = useApi('/worker/policy');
  const [agree, setAgree] = useState(false);
  const { busy, error, run } = useAction();
  if (!policy) return <Loading />;
  return (
    <div className="card">
      <h2>Platform payment policy</h2>
      <p className="small muted">Version {policy.version}. Please read carefully — this is part of your agreement with the platform.</p>
      <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', fontSize: 14, background: 'var(--surface-2)', padding: 12, borderRadius: 10, maxHeight: 360, overflowY: 'auto' }}>{policy.text}</pre>
      {accepted ? <div className="banner ok small">You have accepted the current policy.</div> : (
        <>
          <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /><span>I have read and agree to this policy. I will never ask for or accept payment outside the app.</span></label>
          <ErrorNote error={error} />
          <button className="btn primary block" disabled={!agree || busy} onClick={() => run(async () => {
            await api('/worker/policy/accept', { method: 'POST', body: { version: policy.version, sha256: policy.sha256, agree: true } });
            onAccepted?.();
          })}>I agree</button>
        </>
      )}
    </div>
  );
}

export default function Policy() {
  const [me, , reload] = useApi('/worker/me');
  if (!me) return <Loading />;
  return <PolicyAccept accepted={me.worker.policyAccepted} onAccepted={reload} />;
}
