import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('brand manager sees the allocation console and assigns a lead with a reason', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  // Allocation console
  await page.getByRole('link', { name: 'Allocation', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Lead allocation' })).toBeVisible();
  await expect(page.getByText(/Unassigned queue \(\d+\)/)).toBeVisible();
  await expect(page.getByText('Demo Sales Executive').first()).toBeVisible();

  // A new lead: auto-allocated during working hours, otherwise queued for manual assignment.
  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Allocation ${run}`);
  await page.getByLabel('Mobile').fill(`96${run}21`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(
    page.getByRole('heading', { name: new RegExp(`E2E Allocation ${run}`) }),
  ).toBeVisible();

  const assign = page.getByRole('button', { name: 'Assign', exact: true });
  if (await assign.isVisible()) {
    await expect(page.getByText(/Unassigned/)).toBeVisible();
    await assign.click();
    await page.getByLabel('Assign to').selectOption({ index: 1 });
    await page.getByLabel('Reason (required)').fill('E2E manual assignment');
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
    await expect(page.getByText('“E2E manual assignment”')).toBeVisible();
  }
  // Either way the executive owns the lead and the history and timeline show it.
  await expect(page.getByText('Demo Sales Executive', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/· (auto|manual) ·/).first()).toBeVisible();
  await expect(page.getByText('assigned', { exact: true }).first()).toBeVisible();
});
