import { expect, test } from '@playwright/test';

// Uses the DEMO organization from `pnpm db:seed:demo` (development data only).
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass#2026';

test('log a call and book a counselling session from the lead page', async ({ page }) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill('brand.india@demo.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Engage ${run}`);
  await page.getByLabel('Mobile').fill(`94${run}41`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Engage ${run}`) })).toBeVisible();

  // Log a call
  await page.getByRole('button', { name: 'Log call' }).click();
  await page.getByLabel('Minutes').fill('2');
  await page.getByLabel('Call outcome').selectOption('NO_ANSWER');
  await page.getByLabel('Call notes').fill('Rang out, will retry');
  await page.getByRole('button', { name: 'Save call' }).click();
  await expect(page.getByText('Outbound call · no answer · 2 min')).toBeVisible();
  await expect(page.getByText('Rang out, will retry')).toBeVisible();

  // Book counselling
  await page.getByRole('button', { name: 'Schedule counselling' }).click();
  await page.getByLabel('Counsellor').selectOption({ index: 1 });
  await page.getByLabel('Mode').selectOption('VIDEO');
  await page.getByLabel('Place or meeting link (optional)').fill('https://meet.example.com/e2e');
  await page.getByRole('button', { name: 'Book appointment' }).click();
  await expect(page.getByText('Counselling appointments')).toBeVisible();
  await expect(page.getByText('scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText('· https://meet.example.com/e2e')).toBeVisible();

  // Opt-out blocks email
  await page.getByRole('button', { name: 'Do not contact' }).click();
  await page
    .getByLabel('Why must we stop contacting them?')
    .fill('Asked on the phone not to be contacted');
  await page.getByRole('button', { name: 'Mark do not contact' }).click();
  await expect(page.getByText('Do not contact — messages blocked')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email' })).toBeDisabled();
});
