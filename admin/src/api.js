// API client. The access token lives only in memory; the refresh token
// is an httpOnly cookie the browser sends to /api/auth/refresh. Nothing
// sensitive is written to localStorage.

let accessToken = null;
let refreshing = null;
const listeners = new Set();

export const REFRESH_PATH = '/api/admin-auth/refresh';

export function setToken(t) {
  accessToken = t;
  listeners.forEach((l) => l(t));
}
export function onTokenChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export async function refresh() {
  if (!refreshing) {
    refreshing = fetch(REFRESH_PATH, { method: 'POST', credentials: 'include' })
      .then(async (r) => {
        if (!r.ok) { setToken(null); return null; }
        const j = await r.json();
        setToken(j.accessToken);
        return j;
      })
      .catch(() => { setToken(null); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api(path, { method = 'GET', body, form, retry = true } = {}) {
  const headers = {};
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`/api${path}`, { method, headers, body: payload, credentials: 'include' });
  if (res.status === 401 && retry && accessToken) {
    const r = await refresh();
    if (r) return api(path, { method, body, form, retry: false });
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.blob();
  if (!res.ok) throw new ApiError(res.status, isJson ? data : null);
  return data;
}

export const rupees = (paise) => {
  const p = Number(paise || 0);
  const digits = p % 100 === 0 ? 0 : 2;
  return `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

export const fmtDateTime = (iso) => new Date(iso).toLocaleString('en-IN', {
  weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata',
});
export const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
