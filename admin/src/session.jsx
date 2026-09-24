import { createContext, useContext, useEffect, useState } from 'react';
import { api, onTokenChange, refresh, setToken } from './api.js';

const Ctx = createContext(null);

export function AdminSessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, admin: null, permissions: [], allPermissions: {} });

  async function loadMe() {
    try {
      const me = await api('/admin/me');
      setState({ loading: false, admin: me.admin, permissions: me.permissions, allPermissions: me.allPermissions });
    } catch {
      setState({ loading: false, admin: null, permissions: [], allPermissions: {} });
    }
  }

  useEffect(() => {
    refresh().then((r) => (r ? loadMe() : setState((s) => ({ ...s, loading: false }))));
    return onTokenChange((t) => { if (!t) setState({ loading: false, admin: null, permissions: [], allPermissions: {} }); });
  }, []);

  const value = {
    ...state,
    can: (p) => state.permissions.includes(p),
    async signIn(token) { setToken(token); await loadMe(); },
    async signOut() { await api('/admin-auth/logout', { method: 'POST' }).catch(() => {}); setToken(null); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAdmin = () => useContext(Ctx);
