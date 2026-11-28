import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('reports: KPI tiles drill down to records; breakdown by campaign shows spend columns', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  // A fresh lead this month, so "Leads created" has at least one record.
  await page.goto('/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Report ${run}`);
  await page.getByLabel('Mobile').fill(`90${run}82`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Report ${run}`) })).toBeVisible();

  await page.goto('/');
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await page.getByRole('button', { name: /^Leads created \d+: show records$/ }).click();
  await expect(page.getByRole('heading', { name: 'Leads created — records' })).toBeVisible();
  await expect(page.getByRole('cell', { name: `E2E Report ${run}` })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export summary (CSV)' })).toHaveAttribute(
    'href',
    /\/api\/v1\/reports\/export\?.*report=summary/,
  );

  await page.getByLabel('Break down by').selectOption('campaign');
  await expect(page.getByRole('columnheader', { name: 'CPA' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Funnel' })).toContainText('New enquiry');
});

test('targets and incentives: add a brand target; preview a run that its creator cannot approve', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/targets');
  const form = page.locator('form', { has: page.getByRole('button', { name: 'Add target' }) });
  await form.getByLabel('Target for').selectOption('BRAND');
  await form.getByLabel('Target brand').selectOption({ index: 1 });
  await form.getByLabel('Target metric').selectOption('ASSIGNED');
  await form.getByLabel('Target count').fill(`9${run.slice(-3)}`);
  await form.getByRole('button', { name: 'Add target' }).click();
  await expect(page.getByText(`of 9${run.slice(-3)}`)).toBeVisible();

  await page.goto('/incentives');
  const rule = page.locator('form', { has: page.getByRole('button', { name: 'Save rule' }) });
  await rule.getByLabel('Name').fill(`E2E rule ${run}`);
  await rule.getByLabel('Amount per admission').fill('500');
  await rule.getByRole('button', { name: 'Save rule' }).click();
  await expect(page.getByRole('cell', { name: new RegExp(`E2E rule ${run}`) })).toBeVisible();

  const preview = page.locator('form', { has: page.getByRole('button', { name: 'Preview' }) });
  await preview.getByLabel('Rule version').selectOption({ label: `E2E rule ${run} v1` });
  await preview.getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByText('Needs approval by someone other than its creator')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve and lock' })).toHaveCount(0);
});
