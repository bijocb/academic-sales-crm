import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('insights: dashboard card leads to the insights page; the assistant explains when it is off', async ({
  page,
}) => {
  await page.goto('/');
  const card = page.locator('section', {
    has: page.getByRole('heading', { name: 'Insights — last 7 days' }),
  });
  await expect(card).toBeVisible();
  await card.getByRole('link', { name: 'All insights and Ask the CRM →' }).click();
  await expect(page.getByRole('heading', { name: 'Insights & assistant' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Insights \d{4}-\d{2}-\d{2} – / })).toBeVisible();
  await page.getByLabel('Period').selectOption('30');
  await expect(page.getByRole('heading', { name: /\(vs / })).toBeVisible();
  const ask = page.locator('section', { has: page.getByRole('heading', { name: 'Ask the CRM' }) });
  await expect(ask).toBeVisible();
  // The demo organization has not switched the assistant on, and a brand manager cannot.
  await expect(ask.getByText(/switched off for your organization/)).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Assistant settings (organization)' }),
  ).toHaveCount(0);
});
