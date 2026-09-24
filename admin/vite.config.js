import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Production builds live under /ops/ so one server can host the customer
// app at / and the admin panel at /ops/ (free single-server hosting), or
// the admin panel alone on its own host (which redirects / to /ops/).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/ops/' : '/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: { '/api': process.env.API_URL || 'http://localhost:4000' },
  },
}));
