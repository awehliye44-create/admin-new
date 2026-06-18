import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

const authEmail = process.env.PLAYWRIGHT_ADMIN_EMAIL;
const authPassword = process.env.PLAYWRIGHT_ADMIN_PASSWORD;

test('trip history route map canvas in detail dialog', async ({ page }, testInfo) => {
  testInfo.annotations.push({
    type: 'note',
    description: 'Requires admin login and at least one completed trip unless PLAYWRIGHT_ADMIN_* set',
  });

  const needsAuthCreds = !authEmail || !authPassword;
  const tile403: string[] = [];
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('api.mapbox.com') && res.status() === 403) {
      tile403.push(url.split('?')[0]);
    }
  });

  await page.goto('/trip-history', { waitUntil: 'networkidle' });

  const onAuth = await page.getByRole('button', { name: 'Sign In' }).isVisible().catch(() => false);
  if (onAuth) {
    if (needsAuthCreds) {
      test.skip(
        true,
        'Set PLAYWRIGHT_ADMIN_EMAIL and PLAYWRIGHT_ADMIN_PASSWORD for /trip-history route map test',
      );
    }
    await page.getByLabel('Email').fill(authEmail!);
    await page.getByLabel('Password').fill(authPassword!);
    await page.getByRole('button', { name: 'Sign In' }).click();
    await page.waitForURL(/trip-history/, { timeout: 60_000 });
    await page.goto('/trip-history', { waitUntil: 'networkidle' });
  }

  const tripRow = page.locator('table tbody tr').first();
  const hasTrips = (await tripRow.count()) > 0;
  if (!hasTrips) {
    test.skip(true, 'No completed trips in selected date range — widen filter or seed data');
  }

  await tripRow.getByRole('button').first().click();

  const mapShell = page.getByTestId('trip-history-route-map');
  await expect(mapShell).toBeVisible({ timeout: 15_000 });

  const errorBanner = page.getByRole('alert');
  const hasError = await errorBanner.isVisible().catch(() => false);
  if (hasError) {
    const text = await errorBanner.innerText();
    expect(text, 'map error banner should mention token setup').toMatch(/Map unavailable|token/i);
    await page.screenshot({
      path: path.join('e2e', 'artifacts', 'trip-history-route-map-error.png'),
      fullPage: true,
    });
    test.fail(true, `Map error banner visible: ${text.slice(0, 200)}`);
  }

  const canvas = mapShell.locator('.mapboxgl-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 45_000 });

  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect(box?.height ?? 0).toBeGreaterThan(100);

  expect(tile403, `Mapbox 403 responses: ${tile403.join(', ')}`).toHaveLength(0);

  fs.mkdirSync(path.join('e2e', 'artifacts'), { recursive: true });
  await page.screenshot({
    path: path.join('e2e', 'artifacts', 'trip-history-route-map-ok.png'),
    fullPage: true,
  });
});
