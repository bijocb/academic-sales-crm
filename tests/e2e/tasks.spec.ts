import { expect, test } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

// Signed in once as the demo brand manager (auth.setup.ts).
test.use({ storageState: BRAND_MANAGER_STATE });

test('first-call task: complete with an outcome and a next action, which resolves the SLA', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Task ${run}`);
  await page.getByLabel('Mobile').fill(`95${run}31`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Task ${run}`) })).toBeVisible();

  // Outside working hours the lead waits in the queue: assign it so the first-call task exists.
  const assign = page.getByRole('button', { name: 'Assign', exact: true });
  if (await assign.isVisible()) {
    await assign.click();
    await page.getByLabel('Assign to').selectOption({ index: 1 });
    await page.getByLabel('Reason (required)').fill('E2E task flow');
    await page.getByRole('button', { name: 'Assign', exact: true }).click();
  }
  await expect(page.getByText('Tasks · 1 open')).toBeVisible();
  await expect(page.getByText('First call', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('On track')).toBeVisible();

  await page.getByRole('button', { name: 'Complete', exact: true }).click();
  await page.getByLabel('Outcome').selectOption('NO_ANSWER');
  await page.getByLabel('Notes').fill('Rang twice');
  await page.getByLabel('Next action note (optional)').fill('Try again in the evening');
  await page.getByRole('button', { name: 'Save outcome' }).click();

  await expect(page.getByText('First response made')).toBeVisible();
  await expect(page.getByText('Try again in the evening').first()).toBeVisible();
  await expect(page.getByText('Tasks · 1 open')).toBeVisible();

  // The new task shows on My tasks for its owner's managers via the team view.
  await page.getByRole('link', { name: 'My tasks' }).click();
  await expect(page.getByRole('heading', { name: 'My tasks' })).toBeVisible();
  await page.getByLabel('Whose tasks').selectOption('team');
  await expect(
    page.getByRole('link', { name: new RegExp(`E2E Task ${run}`) }).first(),
  ).toBeVisible();
});
