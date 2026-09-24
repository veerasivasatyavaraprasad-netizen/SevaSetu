import { useState } from 'react';
import { api, setToken } from './api.js';
import { useAdmin } from './session.jsx';
import { ErrorNote, Field, useAction } from './ui.jsx';

export default function Login() {
  const { signIn } = useAdmin();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [stage, setStage] = useState('password');
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const { busy, error, run } = useAction();

  const login = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/admin-auth/login', { method: 'POST', body: { email, password } });
      setToken(r.pendingToken);
      setPassword('');
      if (r.stage === 'totp_setup') setSetup(await api('/admin-auth/totp/setup', { method: 'POST' }));
      setStage('totp');
    });
  };

  const verify = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/admin-auth/totp/verify', { method: 'POST', body: { code } });
      await signIn(r.accessToken);
    });
  };

  return (
    <main className="app" style={{ maxWidth: 420, paddingTop: 64 }}>
      <h1 className="brand">SevaSetu <span>Admin</span></h1>
      <p className="muted small">Authorised staff only. All sign-in attempts are logged with IP and device.</p>
      <div className="card mt">
        {stage === 'password' ? (
          <form onSubmit={login}>
            <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
            <Field label="Password"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
            <ErrorNote error={error} />
            <button className="btn primary block" disabled={busy}>Continue</button>
          </form>
        ) : (
          <form onSubmit={verify}>
            {setup && (
              <>
                <h2>Set up two-factor authentication</h2>
                <p className="small muted">Two-factor authentication is mandatory. Scan this with Google Authenticator, Authy or 1Password.</p>
                <img src={setup.qrDataUrl} alt="Authenticator QR code" width={200} height={200} style={{ display: 'block', margin: '8px auto', background: '#fff', padding: 8, borderRadius: 8 }} />
                <p className="small muted center">Or enter this key: <span className="mono">{setup.secret}</span></p>
              </>
            )}
            <Field label="6-digit code from your authenticator app">
              <input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required autoFocus />
            </Field>
            <ErrorNote error={error} />
            <button className="btn primary block" disabled={busy || code.length !== 6}>Verify</button>
          </form>
        )}
      </div>
    </main>
  );
}
