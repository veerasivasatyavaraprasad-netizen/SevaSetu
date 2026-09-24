import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { api } from '../src/api';
import { useSession } from '../src/session';
import { Banner, Button, Card, Check, Chips, ErrorNote, Field, Screen, T, useAction, useTheme } from '../src/ui';

export default function Login() {
  const t = useTheme();
  const { signIn } = useSession();
  const [role, setRole] = useState('customer');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState('phone');
  const [needsConsent, setNeedsConsent] = useState(false);
  const [consent, setConsent] = useState(false);
  const { busy, error, run, setError } = useAction();

  const requestOtp = () => run(async () => {
    await api('/auth/otp/request', { method: 'POST', body: { phone, role } });
    setStage('otp');
  });

  const verify = () => run(async () => {
    try {
      const r = await api('/auth/otp/verify', { method: 'POST', body: { phone, role, code, ...(consent ? { acceptPrivacyPolicy: true } : {}) } });
      await signIn(r);
      router.replace('/');
    } catch (e) {
      if (e.body?.details?.some((d) => d.path === 'acceptPrivacyPolicy')) {
        setNeedsConsent(true);
        setError(null);
        return;
      }
      throw e;
    }
  });

  return (
    <Screen>
      <View style={{ height: 48 }} />
      <T style={{ fontSize: 30, fontWeight: '800' }}>Seva<T style={{ fontSize: 30, fontWeight: '800', color: t.brand }}>Setu</T></T>
      <T muted>Verified professionals. Fixed prices. Pay safely in the app.</T>
      <Card>
        <Chips value={role} onChange={(r) => { setRole(r); setStage('phone'); }} options={[['customer', 'I need a service'], ['worker', "I'm a professional"]]} />
        {stage === 'phone' ? (
          <>
            <Field label="Mobile number" value={phone} onChangeText={setPhone} keyboardType="phone-pad" autoComplete="tel" maxLength={14} placeholder="98765 43210" />
            <ErrorNote error={error} />
            <Button kind="primary" title="Get OTP" onPress={requestOtp} busy={busy} disabled={phone.replace(/\D/g, '').length < 10} />
          </>
        ) : (
          <>
            <T small muted>Enter the 6-digit code sent to {phone}.</T>
            <Field label="OTP" value={code} onChangeText={(v) => setCode(v.replace(/\D/g, ''))} keyboardType="number-pad" maxLength={6}
              autoComplete="sms-otp" textContentType="oneTimeCode" autoFocus style={{ letterSpacing: 8, fontSize: 22, textAlign: 'center' }} />
            {needsConsent && (
              <>
                <Banner>Welcome! You're creating a new account.</Banner>
                <Check checked={consent} onChange={setConsent}>
                  I agree to the Privacy Policy and consent to my phone number{role === 'worker' ? ', ID documents and bank details' : ' and addresses'} being processed to provide this service. I can export or delete my data at any time.
                </Check>
              </>
            )}
            <ErrorNote error={error} />
            <Button kind="primary" title="Continue" onPress={verify} busy={busy} disabled={code.length !== 6 || (needsConsent && !consent)} />
            <Button kind="ghost" title="Change number" onPress={() => { setStage('phone'); setCode(''); }} />
          </>
        )}
      </Card>
    </Screen>
  );
}
