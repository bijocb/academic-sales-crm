import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts). The sandbox gateway exists only outside production.
test.use({ storageState: BRAND_MANAGER_STATE });

test('payment link → sandbox checkout → signed webhook confirms the admission', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Pay ${run}`);
  await page.getByLabel('Mobile').fill(`90${run}81`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Pay ${run}`) })).toBeVisible();
  const leadUrl = page.url();

  await page.getByRole('button', { name: 'New quotation' }).click();
  await page.getByLabel('Quote course').selectOption({ label: '[DEMO] Data Science Professional' });
  await page.getByLabel('Batch').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Issue quotation' }).click();
  await page.getByRole('button', { name: 'Student accepted' }).click();
  await page.getByRole('button', { name: 'Start admission' }).click();
  await expect(page.getByText(/outstanding/)).toBeVisible();

  await page.getByRole('button', { name: 'Create payment link' }).click();
  const link = page.getByRole('link', { name: /\/api\/v1\/sandbox\/checkout\// });
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');

  // The customer pays on the (sandbox) gateway page; only the signed webhook marks it paid.
  await page.goto(href!);
  await expect(page.getByText('SANDBOX — test payments only, no real money.')).toBeVisible();
  await page.getByRole('button', { name: 'Pay (success)' }).click();
  await expect(page.getByText(/payment completed/)).toBeVisible();

  await page.goto(leadUrl);
  await expect(page.getByText('CONVERTED', { exact: true })).toBeVisible();
  await expect(page.getByText('confirmed', { exact: true })).toBeVisible();
  await expect(page.getByText('verified by gateway')).toBeVisible();
});
