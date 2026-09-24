import * as ImagePicker from 'expo-image-picker';
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { api } from '../src/api';
import { useSession } from '../src/session';
import {
  Banner, Button, Card, Chips, ErrorNote, Field, H, Loading, Row, Screen, T, useAction, useApi,
} from '../src/ui';
import PolicyCard from '../src/PolicyCard';

const SKILL = {
  cleaning: 'Cleaning', repairs: 'Repairs', ac_service: 'AC service', pest_control: 'Pest control',
  tutoring: 'Tutoring', plumbing: 'Plumbing', electrical: 'Electrical', appliance_repair: 'Appliances',
};

export default function Onboarding() {
  const { reload: reloadSession, signOut, worker } = useSession();
  const [me, loadErr, reload] = useApi('/worker/me');
  useEffect(() => { if (worker?.kycStatus === 'approved') router.replace('/jobs'); }, [worker]);
  if (loadErr && !me) return <Screen><ErrorNote error={loadErr} /></Screen>;
  if (!me) return <Screen><Loading /></Screen>;
  const w = me.worker;

  if (w.kycStatus === 'under_review') {
    return (
      <Screen>
        <Card>
          <H>Under review</H>
          <T muted>Thanks, {w.name?.split(' ')[0]}! Our team is verifying your documents. You'll get a notification when you can start accepting jobs.</T>
          <Button kind="primary" title="Check status" onPress={async () => { await reload(); await reloadSession(); }} />
        </Card>
        <Button kind="ghost" title="Sign out" onPress={async () => { await signOut(); router.replace('/login'); }} />
      </Screen>
    );
  }
  const docs = new Set(w.documents.map((d) => d.doc_type));
  const steps = [!!w.idLast4 && !!w.skillCategory, docs.has('id_front') && docs.has('selfie'), w.payoutVerified, w.policyAccepted];
  const ready = steps.every(Boolean);
  return (
    <Screen onRefresh={reload}>
      {w.kycStatus === 'rejected' && <Banner tone="danger">{`Verification not approved: ${w.kycRejectionReason}. Please fix and resubmit.`}</Banner>}
      <T small muted>Step {Math.min(steps.filter(Boolean).length + 1, 4)} of 4</T>
      <ProfileStep w={w} skills={me.skills} done={steps[0]} onDone={reload} />
      <DocsStep docs={docs} done={steps[1]} onDone={reload} />
      <PayoutStep w={w} done={steps[2]} onDone={reload} />
      <PolicyCard accepted={w.policyAccepted} onAccepted={reload} />
      <SubmitStep ready={ready} onDone={async () => { await reload(); await reloadSession(); }} />
    </Screen>
  );
}

function ProfileStep({ w, skills, done, onDone }) {
  const [open, setOpen] = useState(!done);
  const [f, setF] = useState({ name: w.name || '', skillCategory: w.skillCategory || skills[0], serviceAreaPincode: w.serviceAreaPincode || '', idType: 'aadhaar', idNumber: '' });
  const { busy, error, run } = useAction();
  if (!open) return <Card><Row><T small style={{ flex: 1 }}>✓ {w.name} · {SKILL[w.skillCategory]} · {w.serviceAreaPincode} · ID ••{w.idLast4}</T><Button small kind="ghost" title="Edit" onPress={() => setOpen(true)} /></Row></Card>;
  return (
    <Card>
      <H level={2}>1. About you</H>
      <Field label="Full name (as on ID)" value={f.name} onChangeText={(v) => setF({ ...f, name: v })} />
      <T small muted>Skill</T>
      <Chips value={f.skillCategory} onChange={(v) => setF({ ...f, skillCategory: v })} options={skills.map((s) => [s, SKILL[s] || s])} />
      <Field label="Service area PIN code" value={f.serviceAreaPincode} onChangeText={(v) => setF({ ...f, serviceAreaPincode: v })} keyboardType="number-pad" maxLength={6} />
      <T small muted>ID type</T>
      <Chips value={f.idType} onChange={(v) => setF({ ...f, idType: v })} options={[['aadhaar', 'Aadhaar'], ['pan', 'PAN'], ['voter_id', 'Voter ID'], ['driving_licence', 'Driving licence']]} />
      <Field label="ID number" value={f.idNumber} onChangeText={(v) => setF({ ...f, idNumber: v })} autoCapitalize="characters" autoCorrect={false} />
      <T small muted>Your ID number is encrypted. Only the last 4 digits are ever shown.</T>
      <ErrorNote error={error} />
      <Button kind="primary" title="Save" busy={busy} onPress={() => run(async () => { await api('/worker/onboarding', { method: 'POST', body: f }); setOpen(false); onDone(); })} />
    </Card>
  );
}

function DocsStep({ docs, done, onDone }) {
  const { busy, error, run } = useAction();
  const upload = (docType, useCamera) => run(async () => {
    const perm = useCamera ? await ImagePicker.requestCameraPermissionsAsync() : { granted: true };
    if (!perm.granted) throw new Error('Camera permission is needed');
    const opts = { mediaTypes: 'images', quality: 0.7, cameraType: docType === 'selfie' ? ImagePicker.CameraType.front : ImagePicker.CameraType.back };
    const r = useCamera ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
    if (r.canceled) return;
    const a = r.assets[0];
    const form = new FormData();
    form.append('docType', docType);
    form.append('file', { uri: a.uri, name: a.fileName || `${docType}.jpg`, type: a.mimeType || 'image/jpeg' });
    await api('/worker/kyc/documents', { method: 'POST', form });
    onDone();
  });
  return (
    <Card>
      <H level={2}>2. Documents {done ? '✓' : ''}</H>
      <T small muted>Clear photos, stored encrypted.</T>
      {[['id_front', 'ID — front'], ['id_back', 'ID — back (optional)'], ['selfie', 'Selfie']].map(([k, label]) => (
        <Row key={k}>
          <T small style={{ flex: 1 }}>{docs.has(k) ? '✓ ' : ''}{label}</T>
          <Button small title="📷 Camera" busy={busy} onPress={() => upload(k, true)} />
          {k !== 'selfie' && <Button small title="Gallery" busy={busy} onPress={() => upload(k, false)} />}
        </Row>
      ))}
      <ErrorNote error={error} />
    </Card>
  );
}

function PayoutStep({ w, done, onDone }) {
  const [open, setOpen] = useState(!done);
  const [method, setMethod] = useState('bank_account');
  const [f, setF] = useState({ holderName: w.name || '', accountNumber: '', ifsc: '', vpa: '' });
  const { busy, error, run } = useAction();
  useEffect(() => { if (w.name) setF((p) => (p.holderName ? p : { ...p, holderName: w.name })); }, [w.name]);
  if (!open) return <Card><Row><T small style={{ flex: 1 }}>✓ Payouts to {w.payoutMasked}</T><Button small kind="ghost" title="Change" onPress={() => setOpen(true)} /></Row></Card>;
  const body = method === 'vpa' ? { method, holderName: f.holderName, vpa: f.vpa } : { method, holderName: f.holderName, accountNumber: f.accountNumber, ifsc: f.ifsc };
  return (
    <Card>
      <H level={2}>3. Where should we pay you?</H>
      <Chips value={method} onChange={setMethod} options={[['bank_account', 'Bank account'], ['vpa', 'UPI']]} />
      <Field label="Account holder name" value={f.holderName} onChangeText={(v) => setF({ ...f, holderName: v })} />
      {method === 'bank_account' ? (
        <>
          <Field label="Account number" value={f.accountNumber} onChangeText={(v) => setF({ ...f, accountNumber: v })} keyboardType="number-pad" secureTextEntry />
          <Field label="IFSC" value={f.ifsc} onChangeText={(v) => setF({ ...f, ifsc: v.toUpperCase() })} autoCapitalize="characters" maxLength={11} />
        </>
      ) : <Field label="UPI ID" value={f.vpa} onChangeText={(v) => setF({ ...f, vpa: v })} autoCapitalize="none" placeholder="name@bank" />}
      <T small muted>We verify with a ₹1 test deposit. Your account number isn't stored by us — only a secure token from our payment partner.</T>
      <ErrorNote error={error} />
      <Button kind="primary" title="Verify account" busy={busy} onPress={() => run(async () => { await api('/worker/payout-account', { method: 'POST', body }); setOpen(false); onDone(); })} />
    </Card>
  );
}

function SubmitStep({ ready, onDone }) {
  const { busy, error, run } = useAction();
  return (
    <Card>
      <ErrorNote error={error} />
      <Button kind="primary" title="Submit for verification" busy={busy} disabled={!ready}
        onPress={() => run(async () => { await api('/worker/kyc/submit', { method: 'POST' }); onDone(); })} />
      {!ready && <T small muted center>Complete all steps above to submit.</T>}
    </Card>
  );
}
