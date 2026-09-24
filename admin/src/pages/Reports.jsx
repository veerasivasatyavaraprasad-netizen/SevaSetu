import { useState } from 'react';
import { rupees } from '../api.js';
import { ErrorNote, Loading, useApi } from '../ui.jsx';
import { Stat, Table } from './common.jsx';

const ymd = (d) => new Date(d.getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);

export default function Reports() {
  const [from, setFrom] = useState(ymd(new Date(Date.now() - 29 * 86400_000)));
  const [to, setTo] = useState(ymd(new Date()));
  const [d, error] = useApi(`/admin/reports?from=${from}&to=${to}`);
  return (
    <div className="stack">
      <h1>Reports</h1>
      <div className="toolbar">
        <label className="small">From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="small">To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorNote error={error} />
      {!d ? <Loading /> : (
        <>
          <div className="stats">
            <Stat label="Confirmed jobs" value={d.totals.jobs} />
            <Stat label="GMV" value={rupees(d.totals.gmv)} />
            <Stat label="Commission revenue" value={rupees(d.totals.commission)} />
            <Stat label="Worker earnings" value={rupees(d.totals.worker_earnings)} />
            <Stat label="Cash-complaint rate" value={`${d.cashComplaintRatePercent}%`} tone={d.cashComplaintRatePercent > 1 ? 'danger' : undefined} />
            <Stat label="Cash reports / completed" value={`${d.cashReports} / ${d.completedJobs}`} />
          </div>
          <div className="cols">
            <div><h2>By service</h2><Table rows={d.byService} cols={[['name', 'Service'], ['jobs', 'Jobs'], ['gmv', 'GMV', (r) => rupees(r.gmv)], ['commission', 'Commission', (r) => rupees(r.commission)]]} /></div>
            <div><h2>Bookings by status</h2><Table rows={d.bookingsByStatus} cols={[['status', 'Status'], ['n', 'Count']]} /></div>
          </div>
          <div className="cols">
            <div><h2>Top workers</h2><Table rows={d.topWorkers} cols={[['name', 'Worker'], ['rating_avg', 'Rating'], ['rating_count', 'Ratings'], ['total_jobs', 'Jobs']]} /></div>
            <div><h2>Bottom workers</h2><Table rows={d.bottomWorkers} cols={[['name', 'Worker'], ['rating_avg', 'Rating'], ['total_jobs', 'Jobs'], ['strikes', 'Strikes']]} /></div>
          </div>
          <h2>Franchise settlement by city</h2>
          <Table rows={d.byCity} cols={[
            ['name', 'City'], ['franchise_operator', 'Operator', (r) => r.franchise_operator || 'company-run'],
            ['jobs', 'Jobs'], ['gmv', 'GMV', (r) => rupees(r.gmv)], ['commission', 'Commission', (r) => rupees(r.commission)],
            ['share', 'Share', (r) => `${r.franchise_revenue_share_bps / 100}%`],
            ['franchise_share', 'Owed to operator', (r) => rupees(r.franchise_share)],
          ]} />
          <h2>Fraud flags by type</h2>
          <Table rows={d.flagsByType} cols={[['flag_type', 'Type'], ['n', 'Count']]} />
        </>
      )}
    </div>
  );
}
