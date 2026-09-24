import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, NavLink, Route, Routes } from 'react-router-dom';
import './styles.css';
import { AdminSessionProvider, useAdmin } from './session.jsx';
import { Loading } from './ui.jsx';
import Login from './Login.jsx';
import Dashboard from './pages/Dashboard.jsx';
import { BookingDetail, Bookings } from './pages/Bookings.jsx';
import { WorkerDetail, Workers } from './pages/Workers.jsx';
import Customers from './pages/Customers.jsx';
import Payouts from './pages/Payouts.jsx';
import { Disputes, Refunds } from './pages/Disputes.jsx';
import Fraud from './pages/Fraud.jsx';
import Changes from './pages/Changes.jsx';
import Services from './pages/Services.jsx';
import Reports from './pages/Reports.jsx';
import Audit from './pages/Audit.jsx';
import Admins from './pages/Admins.jsx';
import Jobs from './pages/Jobs.jsx';
import Cities from './pages/Cities.jsx';
import Ads from './pages/Ads.jsx';

// [path, label, component, any-of permissions]
const SECTIONS = [
  ['/', 'Dashboard', Dashboard, ['reports.view']],
  ['/bookings', 'Bookings', Bookings, ['bookings.manage']],
  ['/workers', 'Workers', Workers, ['workers.kyc']],
  ['/customers', 'Customers', Customers, ['customers.view']],
  ['/payouts', 'Payouts', Payouts, ['payouts.prepare', 'payouts.approve']],
  ['/disputes', 'Disputes', Disputes, ['disputes.manage']],
  ['/refunds', 'Refund approvals', Refunds, ['refunds.approve', 'disputes.manage']],
  ['/fraud', 'Fraud queue', Fraud, ['fraud.review']],
  ['/changes', 'Change approvals', Changes, ['changes.approve', 'commission.request', 'workers.enforce']],
  ['/services', 'Services & pricing', Services, ['catalog.manage']],
  ['/cities', 'Cities & franchises', Cities, ['cities.manage']],
  ['/ads', 'Sponsored placements', Ads, ['ads.manage']],
  ['/reports', 'Reports', Reports, ['reports.view']],
  ['/audit', 'Audit log', Audit, ['audit.view']],
  ['/admins', 'Admins & access', Admins, ['admins.manage', 'changes.approve']],
  ['/jobs', 'Background jobs', Jobs, ['fraud.review']],
];

function Layout() {
  const { admin, permissions, signOut, cityScoped, cities } = useAdmin();
  const allowed = SECTIONS.filter(([, , , perms]) => perms.some((p) => permissions.includes(p)));
  return (
    <div className="admin">
      <nav className="side" aria-label="Admin">
        <span className="brand">SevaSetu <span>Admin</span></span>
        {allowed.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}>{label}</NavLink>)}
        <a href="#signout" onClick={(e) => { e.preventDefault(); signOut(); }}>Sign out</a>
        <span className="small muted" style={{ padding: '12px', display: 'block' }}>
          {admin.name}<br />{admin.email}
          {cityScoped && <><br /><span className="badge brand">City manager: {cities.map((c) => c.name).join(', ')}</span></>}
        </span>
      </nav>
      <main className="content">
        <Routes>
          {allowed.map(([to, , Page]) => <Route key={to} path={to} element={<Page />} />)}
          {permissionsInclude(permissions, 'bookings.manage') && <Route path="/bookings/:id" element={<BookingDetail />} />}
          {permissionsInclude(permissions, 'workers.kyc') && <Route path="/workers/:id" element={<WorkerDetail />} />}
          <Route path="*" element={allowed.length ? <Navigate to={allowed[0][0]} replace /> : <p>You have no permissions assigned. Ask an administrator.</p>} />
        </Routes>
      </main>
    </div>
  );
}

const permissionsInclude = (perms, p) => perms.includes(p);

function Root() {
  const { loading, admin } = useAdmin();
  if (loading) return <Loading />;
  return admin ? <Layout /> : <Login />;
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AdminSessionProvider><Root /></AdminSessionProvider>
    </BrowserRouter>
  </StrictMode>,
);
