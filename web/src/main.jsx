import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import './styles.css';
import { SessionProvider, useSession } from './session.jsx';
import { Loading } from './ui.jsx';
import Login from './pages/Login.jsx';
import Home from './pages/customer/Home.jsx';
import ServiceDetail from './pages/customer/ServiceDetail.jsx';
import Book from './pages/customer/Book.jsx';
import MyBookings from './pages/customer/MyBookings.jsx';
import BookingDetail from './pages/customer/BookingDetail.jsx';
import Subscriptions from './pages/customer/Subscriptions.jsx';
import Profile from './pages/Profile.jsx';
import Onboarding from './pages/worker/Onboarding.jsx';
import WorkerDashboard from './pages/worker/Dashboard.jsx';
import JobDetail from './pages/worker/JobDetail.jsx';
import Earnings from './pages/worker/Earnings.jsx';
import Policy from './pages/worker/Policy.jsx';
import Featured from './pages/worker/Featured.jsx';

function Shell({ tabs, children }) {
  return (
    <>
      <header className="topbar">
        <NavLink to="/" className="brand">Seva<span>Setu</span></NavLink>
        <NavLink to="/profile" className="small">Account</NavLink>
      </header>
      <main className="app">{children}</main>
      <nav className="tabbar" aria-label="Main">
        {tabs.map(([to, ico, label]) => (
          <NavLink key={to} to={to} end={to === '/'}>
            <span className="ico" aria-hidden="true">{ico}</span>{label}
          </NavLink>
        ))}
      </nav>
    </>
  );
}

function CustomerApp() {
  return (
    <Shell tabs={[['/', '⌂', 'Home'], ['/bookings', '☰', 'Bookings'], ['/plans', '↻', 'Plans'], ['/profile', '☺', 'Profile']]}>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/services/:id" element={<ServiceDetail />} />
        <Route path="/book/:id" element={<Book />} />
        <Route path="/bookings" element={<MyBookings />} />
        <Route path="/bookings/:id" element={<BookingDetail />} />
        <Route path="/plans" element={<Subscriptions />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function WorkerApp() {
  const { worker } = useSession();
  // Section 5.2: dashboard only once KYC is approved.
  if (worker?.kycStatus !== 'approved') {
    return (
      <Shell tabs={[['/', '✓', 'Onboarding'], ['/profile', '☺', 'Profile']]}>
        <Routes>
          <Route path="/profile" element={<Profile />} />
          <Route path="*" element={<Onboarding />} />
        </Routes>
      </Shell>
    );
  }
  return (
    <Shell tabs={[['/', '⌂', 'Jobs'], ['/earnings', '₹', 'Earnings'], ['/policy', '§', 'Policy'], ['/profile', '☺', 'Profile']]}>
      <Routes>
        <Route path="/" element={<WorkerDashboard />} />
        <Route path="/jobs/:id" element={<JobDetail />} />
        <Route path="/earnings" element={<Earnings />} />
        <Route path="/policy" element={<Policy />} />
        <Route path="/featured" element={<Featured />} />
        <Route path="/profile" element={<Profile />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Root() {
  const { loading, user } = useSession();
  if (loading) return <Loading />;
  if (!user) return <Login />;
  return user.role === 'worker' ? <WorkerApp /> : <CustomerApp />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <SessionProvider>
        <Root />
      </SessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
