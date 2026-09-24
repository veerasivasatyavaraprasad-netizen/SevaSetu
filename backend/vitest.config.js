import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Tests share one real Postgres database; run files sequentially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: process.env.TEST_DATABASE_URL || 'postgres://sevasetu:sevasetu@localhost:5432/sevasetu_test',
      CORS_ORIGINS: 'http://localhost:5173,http://localhost:5174',
    },
  },
});
