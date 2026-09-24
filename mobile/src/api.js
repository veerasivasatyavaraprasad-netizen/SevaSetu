// API client for the native app. The access token lives in memory; the
// refresh token is kept in the OS keystore (expo-secure-store) and sent in
// the body with X-Client: mobile, since native apps have no cookie jar we
// can rely on. Nothing sensitive goes to AsyncStorage.

import * as SecureStore from 'expo-secure-store';
import { API_URL } from './config';

const REFRESH_KEY = 'sevasetu.refreshToken';
let accessToken = null;
let refreshing = null;
const listeners = new Set();

export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `Request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

export function onSignedOut(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function saveSession({ accessToken: at, refreshToken }) {
  accessToken = at;
  if (refreshToken) await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}

export async function clearSession() {
  accessToken = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY).catch(() => {});
  listeners.forEach((l) => l());
}

export async function refresh() {
  if (!refreshing) {
    refreshing = (async () => {
      const rt = await SecureStore.getItemAsync(REFRESH_KEY);
      if (!rt) return null;
      const res = await fetch(`${API_URL}/api/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Client': 'mobile' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) {
        if (res.status === 401) await clearSession();
        return null;
      }
      const j = await res.json();
      await saveSession(j);
      return j;
    })().catch(() => null).finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api(path, { method = 'GET', body, form, retry = true } = {}) {
  const headers = { 'X-Client': 'mobile' };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(`${API_URL}/api${path}`, { method, headers, body: payload });
  } catch {
    throw new ApiError(0, { message: 'No connection. Check your internet and try again.' });
  }
  if (res.status === 401 && retry && accessToken) {
    const r = await refresh();
    if (r) return api(path, { method, body, form, retry: false });
  }
  const isJson = res.headers.get('content-type')?.includes('application/json');
  const data = isJson ? await res.json() : await res.text();
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
