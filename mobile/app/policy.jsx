import PolicyCard from '../src/PolicyCard';
import { Loading, Screen, useApi } from '../src/ui';

export default function Policy() {
  const [me, , reload] = useApi('/worker/me');
  if (!me) return <Screen><Loading /></Screen>;
  return <Screen><PolicyCard accepted={me.worker.policyAccepted} onAccepted={reload} /></Screen>;
}
