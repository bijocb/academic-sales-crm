import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('AI assistance: switch it on, see the explained estimate, override the priority with a reason', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/settings');
  const ai = page.locator('section', { has: page.getByRole('heading', { name: 'AI assistance' }) });
  await ai.getByLabel('Use AI assistance for this brand').check();
  await ai.getByLabel('Lead priority scores').check();
  await ai.getByRole('button', { name: 'Save AI settings' }).click();
  await expect(ai.getByText('On', { exact: true })).toBeVisible();

  await page.goto('/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E AI ${run}`);
  await page.getByLabel('Mobile').fill(`90${run}83`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E AI ${run}`) })).toBeVisible();

  const panel = page.locator('section', {
    has: page.getByRole('heading', { name: 'AI assistance' }),
  });
  await expect(panel.getByText(/not a guarantee/)).toBeVisible();
  await expect(panel.getByRole('list', { name: 'Score factors' })).toContainText('Source channel');
  await panel.getByRole('button', { name: 'Change priority' }).click();
  await panel.getByLabel('Priority band').selectOption('HIGH');
  await panel.getByLabel('Override reason').fill('Parent called and wants to join this month');
  await panel.getByRole('button', { name: 'Save priority' }).click();
  await expect(panel.getByText(/Priority set to/)).toContainText('HIGH');

  await page.goto('/leads');
  await page.getByLabel('Sort').selectOption('priority');
  await expect(page.getByRole('row').nth(1)).toContainText('HIGH');
});
