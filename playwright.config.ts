import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end smoke tests. Requires a migrated database seeded with `pnpm db:seed:demo`
 * and built apps (`pnpm build`). Starts the API (4000) and web (3000) unless already running.
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: { baseURL: 'http://localhost:3000', ...devices['Desktop Chrome'] },
  webServer: [
    {
      command: 'pnpm --filter @crm/api start',
      url: 'http://localhost:4000/api/v1/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @crm/web start',
      url: 'http://localhost:3000/login',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
