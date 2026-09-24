import { useEffect, useState } from 'react';
import { api } from '../../api.js';
import { useSession } from '../../session.jsx';
import { ErrorNote, Field, Loading, useAction, useApi } from '../../ui.jsx';
import { PolicyAccept } from './Policy.jsx';

const SKILL_LABELS = {
  cleaning: 'Cleaning', repairs: 'Repairs / carpentry', ac_service: 'AC service', pest_control: 'Pest control',
  tutoring: 'Tutoring', plumbing: 'Plumbing', electrical: 'Electrical', appliance_repair: 'Appliance repair',
};

export default function Onboarding() {
  const { reload: reloadSession } = useSession();
  const [me, loadErr, reload] = useApi('/worker/me');
  if (loadErr) return <ErrorNote error={loadErr} />;
  if (!me) return <Loading />;
  const w = me.worker;

  if (w.kycStatus === 'under_review') {
    return (
      <div className="card center">
        <h1>Under review</h1>
        <p className="muted">Thanks, {w.name?.split(' ')[0]}! Our team is verifying your documents. You'll be notified when you can start accepting jobs.</p>
        <button className="btn mt" onClick={() => { reload(); reloadSession(); }}>Check status</button>
      </div>
    );
  }

  const docs = new Set(w.documents.map((d) => d.doc_type));
  const steps = [
    !!w.idLast4 && !!w.skillCategory,
    docs.has('id_front') && docs.has('selfie'),
    w.payoutVerified,
    w.policyAccepted,
  ];
  const current = steps.findIndex((s) => !s);

  return (
    <div className="stack">
      <h1>Join as a professional</h1>
      {w.kycStatus === 'rejected' && <div className="banner danger">Your verification was not approved: {w.kycRejectionReason}. Please fix and resubmit.</div>}
      <div className="steps" aria-label={`Step ${current === -1 ? 4 : current + 1} of 4`}>{steps.map((s, i) => <span key={i} className={s ? 'done' : ''} />)}</div>
      <ProfileStep w={w} skills={me.skills} onDone={reload} done={steps[0]} />
      <DocsStep docs={docs} onDone={reload} done={steps[1]} />
      <PayoutStep w={w} onDone={reload} done={steps[2]} />
      <PolicyAccept accepted={w.policyAccepted} onAccepted={reload} />
      <SubmitStep ready={current === -1} onDone={() => { reload(); reloadSession(); }} />
    </div>
  );
}

function ProfileStep({ w, skills, onDone, done }) {
  const [f, setF] = useState({ name: w.name || '', skillCategory: w.skillCategory || skills[0], serviceAreaPincode: w.serviceAreaPincode || '', idType: 'aadhaar', idNumber: '' });
  const [open, setOpen] = useState(!done);
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!open) {
    return <div className="card row between"><span>✓ {w.name} · {SKILL_LABELS[w.skillCategory]} · {w.serviceAreaPincode} · ID ••{w.idLast4}</span><button className="btn ghost sm" onClick={() => setOpen(true)}>Edit</button></div>;
  }
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/worker/onboarding', { method: 'POST', body: f }); setOpen(false); onDone(); }); }}>
      <h2>1. About you</h2>
      <Field label="Full name (as on ID)"><input value={f.name} onChange={set('name')} required minLength={3} /></Field>
      <div className="grid2">
        <Field label="Skill"><select value={f.skillCategory} onChange={set('skillCategory')}>{skills.map((s) => <option key={s} value={s}>{SKILL_LABELS[s] || s}</option>)}</select></Field>
        <Field label="Service area PIN"><input value={f.serviceAreaPincode} onChange={set('serviceAreaPincode')} required inputMode="numeric" maxLength={6} pattern="[1-9][0-9]{5}" /></Field>
      </div>
      <div className="grid2">
        <Field label="ID type">
          <select value={f.idType} onChange={set('idType')}>
            <option value="aadhaar">Aadhaar</option><option value="pan">PAN</option><option value="voter_id">Voter ID</option><option value="driving_licence">Driving licence</option>
          </select>
        </Field>
        <Field label="ID number"><input value={f.idNumber} onChange={set('idNumber')} required autoComplete="off" /></Field>
      </div>
      <p className="small muted">Your ID number is encrypted. Only the last 4 digits are ever displayed.</p>
      <ErrorNote error={error} />
      <button className="btn primary block" disabled={busy}>Save</button>
    </form>
  );
}

function DocsStep({ docs, onDone, done }) {
  const { busy, error, run } = useAction();
  const upload = (docType) => (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', file);
    run(async () => { await api('/worker/kyc/documents', { method: 'POST', form }); onDone(); });
  };
  const items = [['id_front', 'ID — front'], ['id_back', 'ID — back (optional)'], ['selfie', 'Selfie']];
  return (
    <div className="card">
      <h2>2. Documents {done && '✓'}</h2>
      <p className="small muted">JPEG, PNG or PDF, up to 5 MB. Stored encrypted.</p>
      {items.map(([k, label]) => (
        <label key={k} className="row between" style={{ padding: '8px 0' }}>
          <span>{docs.has(k) ? '✓ ' : ''}{label}</span>
          <input type="file" accept={k === 'selfie' ? 'image/jpeg,image/png' : 'image/jpeg,image/png,application/pdf'} capture={k === 'selfie' ? 'user' : undefined} onChange={upload(k)} disabled={busy} style={{ maxWidth: 210 }} />
        </label>
      ))}
      <ErrorNote error={error} />
    </div>
  );
}

function PayoutStep({ w, onDone, done }) {
  const [method, setMethod] = useState('bank_account');
  const [f, setF] = useState({ holderName: w.name || '', accountNumber: '', ifsc: '', vpa: '' });
  const [open, setOpen] = useState(!done);
  const { busy, error, run } = useAction();
  const set = (k) => (e) => setF({ ...f, [k]: k === 'ifsc' ? e.target.value.toUpperCase() : e.target.value });
  // Pre-fill the holder name once the profile step has saved it.
  useEffect(() => {
    if (w.name) setF((prev) => (prev.holderName ? prev : { ...prev, holderName: w.name }));
  }, [w.name]);
  if (!open) return <div className="card row between"><span>✓ Payouts to {w.payoutMasked}</span><button className="btn ghost sm" onClick={() => setOpen(true)}>Change</button></div>;
  const body = method === 'vpa' ? { method, holderName: f.holderName, vpa: f.vpa } : { method, holderName: f.holderName, accountNumber: f.accountNumber, ifsc: f.ifsc };
  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); run(async () => { await api('/worker/payout-account', { method: 'POST', body }); setOpen(false); onDone(); }); }}>
      <h2>3. Where should we pay you?</h2>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button type="button" className={`chip ${method === 'bank_account' ? 'active' : ''}`} onClick={() => setMethod('bank_account')}>Bank account</button>
        <button type="button" className={`chip ${method === 'vpa' ? 'active' : ''}`} onClick={() => setMethod('vpa')}>UPI</button>
      </div>
      <Field label="Account holder name"><input value={f.holderName} onChange={set('holderName')} required /></Field>
      {method === 'bank_account' ? (
        <div className="grid2">
          <Field label="Account number"><input value={f.accountNumber} onChange={set('accountNumber')} inputMode="numeric" required autoComplete="off" /></Field>
          <Field label="IFSC"><input value={f.ifsc} onChange={set('ifsc')} required maxLength={11} autoComplete="off" /></Field>
        </div>
      ) : <Field label="UPI ID"><input value={f.vpa} onChange={set('vpa')} placeholder="name@bank" required autoComplete="off" /></Field>}
      <p className="small muted">We verify the account with a ₹1 test deposit. Your account number is not stored by us — only a secure token from our payment partner.</p>
      <ErrorNote error={error} />
      <button className="btn primary block" disabled={busy}>{busy ? 'Verifying…' : 'Verify account'}</button>
    </form>
  );
}

function SubmitStep({ ready, onDone }) {
  const { busy, error, run } = useAction();
  return (
    <div className="card">
      <ErrorNote error={error} />
      <button className="btn primary block" disabled={!ready || busy} onClick={() => run(async () => { await api('/worker/kyc/submit', { method: 'POST' }); onDone(); })}>
        Submit for verification
      </button>
      {!ready && <p className="small muted center" style={{ marginTop: 6 }}>Complete all steps above to submit.</p>}
    </div>
  );
}
