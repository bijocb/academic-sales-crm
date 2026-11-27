import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('brand manager captures leads manually and by CSV import; bad rows reach the rejected queue', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  // Seeded demo leads with their original source
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByPlaceholder('Name, phone, email or lead no.').fill('[DEMO]');
  await expect(page.getByRole('cell', { name: '[DEMO] Ananya Menon' })).toBeVisible();
  await expect(page.getByRole('cell', { name: '[DEMO] Omar Haddad' })).toHaveCount(0); // other brand

  // Manual entry
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Walk-in ${run}`);
  await page.getByLabel('Mobile').fill(`98${run}01`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Walk-in ${run}`) })).toBeVisible();
  await expect(page.getByText('Timeline · 1 enquiry')).toBeVisible();

  // CSV import with one invalid row
  await page.getByRole('link', { name: 'Import leads' }).click();
  const csv = `Full Name,Mobile,Course,utm_campaign\nE2E Import A ${run},97${run}11,Data Science,csv-test\nE2E Import Broken ${run},123,Data Science,csv-test\n`;
  await page
    .getByLabel('Lead file')
    .setInputFiles({ name: `e2e-${run}.csv`, mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.getByText(`e2e-${run}.csv: 2 rows`)).toBeVisible();
  await page.getByRole('button', { name: /Check 2 rows/ }).click();
  await expect(page.getByText('1 ready')).toBeVisible();
  await expect(page.getByText('1 with problems')).toBeVisible();
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('Import finished')).toBeVisible();
  await expect(page.getByText('1 new leads')).toBeVisible();
  await expect(page.getByText('1 sent to Rejected leads')).toBeVisible();

  // Fix the rejected row
  await page.getByRole('link', { name: 'Rejected leads' }).click();
  const row = page.getByRole('row', { name: new RegExp(`E2E Import Broken ${run}`) });
  await row.getByRole('button', { name: 'Fix' }).click();
  await page.getByLabel('Mobile').fill(`97${run}22`);
  await page.getByRole('button', { name: 'Create lead' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`E2E Import Broken ${run}`) })).toHaveCount(
    0,
  );
});
