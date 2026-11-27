import { expect, test } from '@playwright/test';

// Uses the DEMO organization from `pnpm db:seed:demo` (development data only).
const PASSWORD = 'DemoPass#2026';

test('brand manager signs in and sees only their brand', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('brand.india@demo.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();

  await page.getByRole('link', { name: 'Brands & branches' }).click();
  await expect(page.getByText('[DEMO] Academy India · ACAD-IN')).toBeVisible();
  await expect(page.getByText('[DEMO] Institute Dubai')).toHaveCount(0);

  await page.getByRole('link', { name: 'Users' }).click();
  await expect(page.getByRole('cell', { name: 'exec@demo.local' })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'admin@demo.local' })).toHaveCount(0);
});

test('organization admin sees both brands and the audit log', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('admin@demo.local');
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('link', { name: 'Brands & branches' }).click();
  await expect(page.getByText('[DEMO] Academy India · ACAD-IN')).toBeVisible();
  await expect(page.getByText('[DEMO] Institute Dubai · INST-AE')).toBeVisible();
  await page.getByRole('link', { name: 'Audit log' }).click();
  await expect(page.getByRole('cell', { name: 'auth.login' }).first()).toBeVisible();
});

test('wrong password shows an error and stays on login', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('exec@demo.local');
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Invalid email or password' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/login/);
});
