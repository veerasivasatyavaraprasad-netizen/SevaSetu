import { Redirect } from 'expo-router';
import { useSession } from '../src/session';
import { Loading, Screen } from '../src/ui';

// Routes by role; workers reach the dashboard only once KYC is approved (§5.2).
export default function Index() {
  const { loading, user, worker } = useSession();
  if (loading) return <Screen><Loading /></Screen>;
  if (!user) return <Redirect href="/login" />;
  if (user.role === 'worker') return <Redirect href={worker?.kycStatus === 'approved' ? '/jobs' : '/onboarding'} />;
  return <Redirect href="/home" />;
}
