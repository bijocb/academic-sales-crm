import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

import { BRAND_MANAGER_STATE } from './session';

/**
 * Accessibility (SRS §8: WCAG 2.1 AA where practical). Scans the main screens with axe-core and fails on serious or
 * critical violations; minor and moderate ones are printed for follow-up (docs/ACCESSIBILITY.md).
 */
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

async function scan(page: Page, name: string) {
  await page.waitForLoadState('networkidle');
  const r = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  for (const v of r.violations)
    console.log(
      `[a11y] ${name}: ${v.impact} ${v.id} (${v.nodes.length}) ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
    );
  expect(
    blocking.map(
      (v) =>
        `${v.id}: ${v.nodes
          .map((n) => n.target.join(' '))
          .slice(0, 5)
          .join(', ')}`,
    ),
    `${name} has serious or critical accessibility violations`,
  ).toEqual([]);
}

test('sign-in page is accessible', async ({ page }) => {
  await page.goto('/login');
  await scan(page, 'login');
});

test.describe('signed-in screens', () => {
  test.use({ storageState: BRAND_MANAGER_STATE });
  for (const [path, name] of [
    ['/', 'dashboard'],
    ['/leads', 'leads'],
    ['/tasks', 'tasks'],
    ['/pipeline', 'pipeline'],
    ['/appointments', 'appointments'],
    ['/recovery', 'recovery'],
    ['/reports', 'reports'],
    ['/targets', 'targets'],
    ['/incentives', 'incentives'],
    ['/settings', 'settings'],
    ['/users', 'users'],
  ] as const)
    test(`${name} is accessible`, async ({ page }) => {
      await page.goto(path);
      await scan(page, name);
    });

  test('lead page is accessible', async ({ page }) => {
    await page.goto('/leads');
    await page.getByRole('row').nth(1).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await scan(page, 'lead');
  });

  test('main navigation and forms work with the keyboard', async ({ page }) => {
    await page.goto('/leads');
    await page.getByRole('button', { name: 'New lead' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Full name')).toBeVisible();
    await page.getByLabel('Full name').focus();
    await page.keyboard.type('Keyboard Only');
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Mobile')).toBeFocused();
  });
});
