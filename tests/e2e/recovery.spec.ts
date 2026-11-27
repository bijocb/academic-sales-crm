import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('mark a lead lost, start recovery and reopen it when the student is interested again', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Lost ${run}`);
  await page.getByLabel('Mobile').fill(`92${run}61`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Lost ${run}`) })).toBeVisible();

  await page.getByRole('button', { name: 'Mark lost' }).click();
  await page.getByLabel('Loss reason').selectOption({ label: 'Fee too high' });
  await page.getByLabel('Loss notes').fill('Looking for a cheaper option');
  await page.getByRole('button', { name: 'Mark lost' }).last().click();
  await expect(page.getByText('LOST', { exact: true })).toBeVisible();
  await expect(page.getByText('scheduled', { exact: true })).toBeVisible();
  await expect(page.getByText(/Lost — Fee too high: Looking for a cheaper option/)).toBeVisible();

  // Managers may start early; outside working hours the start waits (a different executive is needed).
  await page.getByRole('button', { name: 'Start recovery now' }).click();
  const active = page.getByText('active', { exact: true });
  const waits = page.getByText(/Recovery can start in working hours/);
  await expect(active.or(waits)).toBeVisible();
  if (await waits.isVisible()) return;

  await page.getByRole('button', { name: 'Log recovery attempt' }).click();
  await page.getByLabel('Result').selectOption('INTERESTED');
  await page.getByLabel('Attempt notes').fill('Happy with the instalment option');
  await page.getByRole('button', { name: 'Save attempt' }).click();
  await expect(page.getByText('recovered', { exact: true })).toBeVisible();
  await expect(page.getByText('OPEN', { exact: true })).toBeVisible();
  await expect(page.getByText('Recovered — back in the sales pipeline')).toBeVisible();
});
