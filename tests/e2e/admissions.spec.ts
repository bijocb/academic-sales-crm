import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

const PDF = Buffer.from('%PDF-1.4\n% e2e\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

test('accepted quotation → start admission → upload a document', async ({ page }) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Admit ${run}`);
  await page.getByLabel('Mobile').fill(`91${run}71`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Admit ${run}`) })).toBeVisible();

  await page.getByRole('button', { name: 'New quotation' }).click();
  await page.getByLabel('Quote course').selectOption({ label: '[DEMO] Data Science Professional' });
  await page.getByLabel('Batch').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Issue quotation' }).click();
  await page.getByRole('button', { name: 'Student accepted' }).click();
  await expect(page.getByText('accepted', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Start admission' }).click();
  await expect(page.getByText('documents pending', { exact: true })).toBeVisible();
  await page
    .getByLabel('Upload Passport-size photo')
    .setInputFiles({ name: 'photo.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('uploaded', { exact: true })).toBeVisible();
  await expect(page.getByText('Passport-size photo uploaded')).toBeVisible();
});
