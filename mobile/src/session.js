import { createContext, createElement, useContext, useEffect, useState } from 'react';
import { api, clearSession, onSignedOut, refresh, saveSession } from './api';
import { registerForPush } from './push';

const Ctx = createContext(null);

export function SessionProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, worker: null });

  async function loadMe() {
    try {
      const me = await api('/me');
      setState({ loading: false, user: me.user, worker: me.worker });
      registerForPush().catch(() => {});
    } catch {
      setState({ loading: false, user: null, worker: null });
    }
  }

  useEffect(() => {
    refresh().then((r) => (r ? loadMe() : setState({ loading: false, user: null, worker: null })));
    return onSignedOut(() => setState({ loading: false, user: null, worker: null }));
  }, []);

  const value = {
    ...state,
    async signIn(tokens) {
      await saveSession(tokens);
      await loadMe();
    },
    reload: loadMe,
    async signOut() {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      await clearSession();
    },
  };
  return createElement(Ctx.Provider, { value }, children);
}

export const useSession = () => useContext(Ctx);
