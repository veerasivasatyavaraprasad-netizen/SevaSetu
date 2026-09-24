import { useState } from 'react';
import { api } from './api';
import { Banner, Button, Card, Check, ErrorNote, Loading, T, useAction, useApi } from './ui';

// §3.2 training / policy acknowledgement (anti-cash sign-off).
export default function PolicyCard({ accepted, onAccepted }) {
  const [policy] = useApi('/worker/policy');
  const [agree, setAgree] = useState(false);
  const { busy, error, run } = useAction();
  if (!policy) return <Loading />;
  return (
    <Card>
      <T bold>Platform payment policy · version {policy.version}</T>
      <T small>{policy.text}</T>
      {accepted ? <Banner tone="ok">You have accepted the current policy.</Banner> : (
        <>
          <Check checked={agree} onChange={setAgree}>I have read and agree to this policy. I will never ask for or accept payment outside the app.</Check>
          <ErrorNote error={error} />
          <Button kind="primary" title="I agree" busy={busy} disabled={!agree} onPress={() => run(async () => {
            await api('/worker/policy/accept', { method: 'POST', body: { version: policy.version, sha256: policy.sha256, agree: true } });
            onAccepted?.();
          })} />
        </>
      )}
    </Card>
  );
}

