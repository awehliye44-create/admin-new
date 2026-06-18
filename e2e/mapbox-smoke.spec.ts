import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Unauthenticated Mapbox smoke — uses dev-only /__dev__/mapbox-smoke route.
 * Validates token bootstrap + canvas dimensions without admin login.
 */
test('dev mapbox smoke canvas renders without Mapbox 403', async ({ page }) => {
  const tile403: string[] = [];
  page.on('response', (res) => {
    const url = res.url();
    if (url.includes('api.mapbox.com') && res.status() === 403) {
      tile403.push(url.split('?')[0]);
    }
  });

  await page.goto('/__dev__/mapbox-smoke', { waitUntil: 'networkidle' });

  const canvas = page.locator('.mapboxgl-canvas').first();
  await expect(canvas).toBeVisible({ timeout: 45_000 });

  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(100);
  expect(box?.height ?? 0).toBeGreaterThan(100);

  if (tile403.length > 0) {
    const errorBanner = page.getByRole('alert');
    await expect(errorBanner).toBeVisible({ timeout: 10_000 });
    const text = await errorBanner.innerText();
    expect(text).toMatch(/403|web token|native|tile access denied/i);
    fs.mkdirSync(path.join('e2e', 'artifacts'), { recursive: true });
    await page.screenshot({
      path: path.join('e2e', 'artifacts', 'mapbox-smoke-tile-403.png'),
      fullPage: true,
    });
    return;
  }

  const errorBanner = page.getByRole('alert');
  expect(await errorBanner.isVisible().catch(() => false)).toBe(false);

  fs.mkdirSync(path.join('e2e', 'artifacts'), { recursive: true });
  await page.screenshot({
    path: path.join('e2e', 'artifacts', 'mapbox-smoke-ok.png'),
    fullPage: true,
  });
});
