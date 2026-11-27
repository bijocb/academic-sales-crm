import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('brand manager adds a course and a batch, and previews SLA due times', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Courses & batches' }).click();
  await expect(page.getByText('[DEMO] Data Science Professional')).toBeVisible();
  await expect(page.getByText('[DEMO] Project Management Professional')).toHaveCount(0);

  const code = `E2E${Date.now().toString().slice(-6)}`;
  await page.getByRole('button', { name: 'New course' }).click();
  await page.getByLabel('Course name').fill(`E2E Course ${code}`);
  await page.getByRole('textbox', { name: 'Code e.g. DS-PRO' }).fill(code);
  await page.getByLabel('List fee (INR)').fill('12500');
  await page.getByRole('button', { name: 'Create course' }).click();
  const row = page.getByRole('row', { name: new RegExp(`E2E Course ${code}`) });
  await expect(row).toContainText('₹12,500.00');

  await row.getByRole('button', { name: 'Batches' }).click();
  await page.getByLabel('Batch name').fill('Pilot batch');
  await page.getByLabel('Code', { exact: true }).fill('PILOT');
  await page.getByLabel('Start date').fill('2027-03-01');
  await page.getByRole('button', { name: 'Add batch' }).click();
  await expect(page.getByRole('cell', { name: /Pilot batch/ })).toBeVisible();

  await page.getByRole('link', { name: 'Brand settings' }).click();
  await expect(page.getByRole('heading', { name: 'Working hours' })).toBeVisible();
  await page.getByLabel(/Lead arrives/).fill('2026-11-27T22:00');
  await page.getByLabel('SLA minutes').fill('15');
  await page.getByRole('button', { name: 'Calculate' }).click();
  await expect(page.getByText('Due by working clock')).toBeVisible();
  await expect(page.getByText(/Sat 28 Nov, 09:45/)).toBeVisible();
});
