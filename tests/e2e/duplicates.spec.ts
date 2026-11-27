import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('brand manager reviews a suggested duplicate, merges it and sees the combined history', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  // Two manual leads: same name (words swapped), phone with two swapped digits.
  for (const [name, phone] of [
    [`Dup Test ${run}`, `98${run}01`],
    [`Test Dup ${run}`, `98${run}10`],
  ]) {
    await page.goto('/leads');
    await page.getByRole('button', { name: 'New lead' }).click();
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Mobile').fill(phone);
    await page.getByRole('button', { name: 'Save lead' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  }
  await expect(page.getByText(/may be a duplicate/)).toBeVisible();

  await page.getByRole('link', { name: 'Possible duplicates', exact: true }).click();
  const row = page
    .getByRole('row')
    .filter({ hasText: `Dup Test ${run}` })
    .filter({ hasText: `Test Dup ${run}` });
  await expect(row).toContainText('Phone differs by one digit');
  await row.getByRole('button', { name: 'Review' }).click();
  await expect(page.getByText('is combined into')).toBeVisible();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(row).toHaveCount(0);

  await page.goto('/leads');
  await page.getByPlaceholder('Name, phone, email or lead no.').fill(run);
  await page.getByRole('row').filter({ hasText: run }).first().click();
  await expect(page.getByText('Timeline · 2 enquiries')).toBeVisible();
  await expect(page.getByText(/merged into this lead/)).toBeVisible();
});
