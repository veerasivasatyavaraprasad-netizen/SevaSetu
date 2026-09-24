import { createContext, useContext, useEffect, useState } from 'react';
import { api, onTokenChange, refresh, setToken } from './api.js';

const SessionContext = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, worker: null });

  async function loadMe() {
    try {
      const me = await api('/me');
      setState({ loading: false, user: me.user, worker: me.worker });
    } catch {
      setState({ loading: false, user: null, worker: null });
    }
  }

  useEffect(() => {
    // Resume a session from the httpOnly refresh cookie, if any.
    refresh().then((r) => (r ? loadMe() : setState({ loading: false, user: null, worker: null })));
    return onTokenChange((t) => {
      if (!t) setState({ loading: false, user: null, worker: null });
    });
  }, []);

  const value = {
    ...state,
    async signIn(accessToken) {
      setToken(accessToken);
      await loadMe();
    },
    reload: loadMe,
    async signOut() {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      setToken(null);
    },
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export const useSession = () => useContext(SessionContext);
