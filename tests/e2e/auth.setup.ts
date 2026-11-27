import { expect, test as setup } from '@playwright/test';
import { BRAND_MANAGER_STATE, DEMO_PASSWORD } from './session';

// One sign-in for all specs that act as the demo brand manager (login is rate limited to 10/min).
setup('sign in as the demo brand manager', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('brand.india@demo.local');
  await page.getByLabel('Password').fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: /Welcome/ })).toBeVisible();
  await page.context().storageState({ path: BRAND_MANAGER_STATE });
});
