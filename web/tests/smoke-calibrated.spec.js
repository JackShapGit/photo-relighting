import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

// Calibrated-scene smoke: a real /prepare on the portrait fixture, then the
// synthetic stage record applied through the same entry point the panel
// uses. Asserts only the visible contract: the badge text, the feet fields
// in the props pane, the 3D stage object, and zero console errors. The
// synthetic depth fit clamps this photo's background to the far plane, which
// is fine here (nothing about pixel geometry is asserted).
test.setTimeout(120_000);

test('calibrated scene shows badge, feet fields, and 3D stage grid without console errors', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await createSceneFromFixture(page, { name: 'smoke-calibrated', viewMode: 'split' });

  await page.evaluate(() => {
    window.__state.calibration = {
      version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
      marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
      depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null,
    };
    window.__applyCalibration();
  });

  await expect(page.locator('#calibrate-btn')).toHaveText(/40 × 20 × 30 ft/);
  await expect(page.locator('.metric-pos .pos-z')).toBeVisible();
  // The 3D stage is rebuilt asynchronously with the point cloud after the
  // calibration event, so wait for the object rather than sampling once.
  await page.waitForFunction(() => !!window.__scene3d?.getObjectByName('stage'), null, { timeout: 60000 });
  expect(await page.evaluate(() => !!window.__scene3d?.getObjectByName('stage'))).toBe(true);
  expect(errors, errors.join('\n')).toEqual([]);
});
