/** Test environment. Values come from the real env (CI) or fall back to local defaults. */
export const TEST_DB = process.env.TEST_DATABASE_NAME ?? 'crm_test';
const host = process.env.TEST_DB_HOST ?? 'localhost:5432';
const appPw = process.env.CRM_APP_DB_PASSWORD ?? 'change-me-app';
const ownerAuth = process.env.TEST_DB_OWNER_AUTH ?? 'postgres';

export const TEST_ENV = {
  NODE_ENV: 'test',
  APP_DATABASE_URL: `postgresql://crm_app:${appPw}@${host}/${TEST_DB}`,
  MIGRATION_DATABASE_URL: `postgresql://${ownerAuth}@${host}/${TEST_DB}`,
  CRM_APP_DB_PASSWORD: appPw,
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  WEB_ORIGIN: 'http://localhost:3000',
  SMTP_URL: '',
  CRON_SECRET: 'test-cron-secret-test-cron-secret-0123',
} as const;
