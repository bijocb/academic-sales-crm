import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('log a call and book a counselling session from the lead page', async ({ page }) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
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
  // A unique future slot so repeated local runs never collide with earlier bookings.
  const slot = new Date(Date.now() + (2 + (Number(run) % 300)) * 86_400_000);
  slot.setHours(10, Number(run) % 60, 0, 0);
  const local = new Date(slot.getTime() - slot.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
  await page.getByLabel('Starts').fill(local);
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
