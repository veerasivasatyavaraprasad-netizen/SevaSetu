import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';

// Loads data from the API; returns [data, error, reload].
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null });
  const load = useCallback(() => {
    if (!path) return;
    api(path).then((data) => setState({ data, error: null })).catch((error) => setState({ data: null, error }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(load, [load]);
  return [state.data, state.error, load];
}

// Wraps an async action with busy/error state.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Loading() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

export function ErrorNote({ error }) {
  if (!error) return null;
  const details = error.body?.details;
  return (
    <div className="banner danger" role="alert">
      {error.message}
      {Array.isArray(details) && details.length > 0 && (
        <ul className="small" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {details.map((d) => <li key={d.path + d.message}>{d.path ? `${d.path}: ` : ''}{d.message}</li>)}
        </ul>
      )}
    </div>
  );
}

const STATUS = {
  pending_payment: ['Awaiting payment', 'warn'],
  paid: ['Finding a professional', 'brand'],
  assigned: ['Professional assigned', 'brand'],
  in_progress: ['In progress', 'brand'],
  completed: ['Completed — please confirm', 'ok'],
  confirmed: ['Done', 'ok'],
  disputed: ['Issue under review', 'danger'],
  cancelled: ['Cancelled', ''],
  refunded: ['Refunded', ''],
};

const WORKER_LABELS = { assigned: 'Upcoming', in_progress: 'In progress', completed: 'Awaiting customer confirmation', confirmed: 'Confirmed', disputed: 'Under review' };

export function StatusBadge({ status, forWorker = false }) {
  const [base, tone] = STATUS[status] || [status, ''];
  const label = (forWorker && WORKER_LABELS[status]) || base;
  return <span className={`badge ${tone}`}>{label}</span>;
}

export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// Browser geolocation as a promise.
export function getPosition() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error('Location is not available on this device'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracyM: Math.round(p.coords.accuracy) }),
      (e) => reject(new Error(e.code === 1 ? 'Please allow location access to continue' : 'Could not get your location')),
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 },
    );
  });
}
