import { useState } from 'react';
import { api } from '../api.js';
import { useSession } from '../session.jsx';
import { ErrorNote, Field, useAction } from '../ui.jsx';

export default function Login() {
  const { signIn } = useSession();
  const [role, setRole] = useState('customer');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone');
  const [consent, setConsent] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const { busy, error, run, setError } = useAction();

  const requestOtp = (e) => {
    e.preventDefault();
    run(async () => {
      await api('/auth/otp/request', { method: 'POST', body: { phone, role } });
      setStage('otp');
    });
  };

  const verify = (e) => {
    e.preventDefault();
    run(async () => {
      try {
        const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, role, code, ...(consent ? { acceptPrivacyPolicy: true } : {}) } });
        await signIn(r.accessToken);
      } catch (err) {
        if (err.body?.details?.some((d) => d.path === 'acceptPrivacyPolicy')) {
          setNeedsConsent(true);
          setError(null);
          return;
        }
        throw err;
      }
    });
  };

  return (
    <main className="app" style={{ paddingTop: 48 }}>
      <h1 className="brand" style={{ fontSize: 28 }}>Seva<span>Setu</span></h1>
      <p className="muted">Verified professionals. Fixed prices. Pay safely in the app.</p>

      <div className="card mt">
        <div className="chips" role="tablist" style={{ marginBottom: 16 }}>
          <button type="button" role="tab" aria-selected={role === 'customer'} className={`chip ${role === 'customer' ? 'active' : ''}`} onClick={() => { setRole('customer'); setStage('phone'); }}>I need a service</button>
          <button type="button" role="tab" aria-selected={role === 'worker'} className={`chip ${role === 'worker' ? 'active' : ''}`} onClick={() => { setRole('worker'); setStage('phone'); }}>I'm a professional</button>
        </div>

        {stage === 'phone' ? (
          <form onSubmit={requestOtp}>
            <Field label="Mobile number">
              <input inputMode="numeric" autoComplete="tel-national" placeholder="98765 43210" value={phone}
                onChange={(e) => setPhone(e.target.value)} required maxLength={14} />
            </Field>
            <ErrorNote error={error} />
            <button className="btn primary block" disabled={busy}>{busy ? 'Sending…' : 'Get OTP'}</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            <p className="small muted">Enter the 6-digit code sent to {phone}.</p>
            <Field label="OTP">
              <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
                value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
            </Field>
            {needsConsent && (
              <>
                <div className="banner info small">Welcome! You're creating a new account.</div>
                <label className="check">
                  <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
                  <span>I agree to the Privacy Policy and consent to my phone number{role === 'worker' ? ', ID documents and bank details' : ' and addresses'} being processed to provide this service. I can export or delete my data at any time.</span>
                </label>
              </>
            )}
            <ErrorNote error={error} />
            <button className="btn primary block" disabled={busy || code.length !== 6 || (needsConsent && !consent)}>
              {busy ? 'Verifying…' : 'Continue'}
            </button>
            <button type="button" className="btn ghost block" onClick={() => { setStage('phone'); setCode(''); }}>Change number</button>
          </form>
        )}
      </div>
    </main>
  );
}
