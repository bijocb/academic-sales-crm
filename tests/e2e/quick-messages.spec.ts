import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts). Demo templates exist per situation (seed-demo).
test.use({ storageState: BRAND_MANAGER_STATE });

test('quick messages: preview a situation and send it on the ready channels in one click', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/leads');
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Quick ${run}`);
  await page.getByLabel('Mobile').fill(`90${run}84`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Quick ${run}`) })).toBeVisible();

  const card = page.locator('section', {
    has: page.getByRole('heading', { name: 'Quick messages' }),
  });
  await card.getByRole('button', { name: 'College details' }).click();
  await expect(card.getByText(new RegExp(`Hi E2E, .* is at \\[DEMO\\]`))).toBeVisible();
  // No e-mail address on this lead: e-mail is shown as not available, WhatsApp is ready and ticked.
  await expect(card.getByText('This person has no email address')).toBeVisible();
  await card.getByRole('button', { name: /^Send college details on WhatsApp/ }).click();
  await expect(card.getByRole('list', { name: 'Sent messages' })).toContainText(
    'WhatsApp: queued for delivery',
  );
});
