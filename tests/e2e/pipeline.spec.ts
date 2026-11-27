import { expect, test } from '@playwright/test';

// Uses the DEMO organization from `pnpm db:seed:demo` (development data only).
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass#2026';

test('a lead moves forward only when its stage data is present, and shows on the board', async ({
  page,
}) => {
  const run = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill('brand.india@demo.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Leads', exact: true }).click();
  await page.getByRole('button', { name: 'New lead' }).click();
  await page.getByLabel('Full name').fill(`E2E Pipe ${run}`);
  await page.getByLabel('Mobile').fill(`93${run}51`);
  await page.getByRole('button', { name: 'Save lead' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(`E2E Pipe ${run}`) })).toBeVisible();

  // Contacted needs a logged call.
  await expect(page.getByText('Next: Contacted')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Move to Contacted' })).toBeDisabled();
  await page.getByRole('button', { name: 'Log call' }).click();
  await page.getByLabel('Call outcome').selectOption('CONNECTED');
  await page.getByRole('button', { name: 'Save call' }).click();
  await expect(page.getByRole('button', { name: 'Move to Contacted' })).toBeEnabled();
  await page.getByRole('button', { name: 'Move to Contacted' }).click();
  await expect(page.getByText('Next: Qualified')).toBeVisible();
  await expect(page.getByText('New Enquiry → Contacted')).toBeVisible();

  // Qualified needs the qualification details.
  await expect(page.getByRole('button', { name: 'Move to Qualified' })).toBeDisabled();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Highest qualification').fill('B.Sc Computer Science');
  await page.getByLabel('Eligibility notes').fill('Graduate — eligible');
  await page.getByLabel('Goal / requirement').fill('Switch to a data career');
  await page.getByLabel('Interest level').selectOption('HOT');
  await page.getByRole('button', { name: 'Save qualification' }).click();
  await expect(page.getByText('B.Sc Computer Science')).toBeVisible();
  await page.getByRole('button', { name: 'Move to Qualified' }).click();
  await expect(page.getByText('Next: Interested')).toBeVisible();

  // Board
  await page.getByRole('link', { name: 'Pipeline', exact: true }).click();
  await page.getByLabel('Whose leads').selectOption('false');
  const column = page.getByRole('region', { name: 'Qualified' });
  await expect(column.getByText(`E2E Pipe ${run}`)).toBeVisible();
  await expect(column.getByText('hot')).toBeVisible();
});
