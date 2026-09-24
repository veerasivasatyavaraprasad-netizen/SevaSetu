import { useState } from 'react';
import { api, fmtDateTime } from '../api.js';
import { ErrorNote, Loading, useAction, useApi } from '../ui.jsx';
import { Table } from './common.jsx';

export default function Audit() {
  const [action, setAction] = useState('');
  const [tab, setTab] = useState('log');
  const [logs, error] = useApi(`/admin/audit-logs${action ? `?action=${encodeURIComponent(action)}` : ''}`);
  const [attempts] = useApi(tab === 'logins' ? '/admin/login-attempts' : null, [tab]);
  const [verify, setVerify] = useState(null);
  const act = useAction();
  return (
    <div className="stack">
      <h1>Audit log</h1>
      <p className="small muted">Append-only and hash-chained: every row includes the hash of the previous row, so edits or deletions are detectable.</p>
      <div className="toolbar">
        <div className="chips">
          <button type="button" className={`chip ${tab === 'log' ? 'active' : ''}`} onClick={() => setTab('log')}>Actions</button>
          <button type="button" className={`chip ${tab === 'logins' ? 'active' : ''}`} onClick={() => setTab('logins')}>Admin sign-ins</button>
        </div>
        <button className="btn sm" disabled={act.busy} onClick={() => act.run(async () => setVerify(await api('/admin/audit-logs/verify')))}>Verify chain integrity</button>
      </div>
      {verify && (verify.brokenAt === null
        ? <div className="banner ok">Chain intact — {verify.checked} entries verified.</div>
        : <div className="banner danger">Chain broken at entry #{verify.brokenAt}: {verify.reason}. Investigate immediately.</div>)}
      <ErrorNote error={error || act.error} />
      {tab === 'log' ? (
        <>
          <input placeholder="Filter by action prefix, e.g. payout. or worker.strike" value={action} onChange={(e) => setAction(e.target.value)} />
          {!logs ? <Loading /> : (
            <Table rows={logs.logs} cols={[
              ['id', '#'], ['created_at', 'When', (r) => fmtDateTime(r.created_at)],
              ['actor_name', 'Actor', (r) => `${r.actor_name || r.actor_role}`], ['action', 'Action', (r) => <span className="mono small">{r.action}</span>],
              ['target', 'Target', (r) => <span className="small">{r.target_table} <span className="mono">{r.target_id?.slice(0, 8)}</span></span>],
              ['old_value', 'Before', (r) => (r.old_value ? <pre className="json">{JSON.stringify(r.old_value)}</pre> : '')],
              ['new_value', 'After', (r) => (r.new_value ? <pre className="json">{JSON.stringify(r.new_value)}</pre> : '')],
              ['ip_address', 'IP'],
            ]} />
          )}
        </>
      ) : !attempts ? <Loading /> : (
        <Table rows={attempts.attempts} cols={[
          ['created_at', 'When', (r) => fmtDateTime(r.created_at)], ['email', 'Email'], ['stage', 'Stage'],
          ['success', 'Result', (r) => <span className={`badge ${r.success ? 'ok' : 'danger'}`}>{r.success ? 'success' : r.reason}</span>],
          ['ip_address', 'IP'], ['user_agent', 'Device', (r) => <span className="small">{r.user_agent}</span>],
        ]} />
      )}
    </div>
  );
}
