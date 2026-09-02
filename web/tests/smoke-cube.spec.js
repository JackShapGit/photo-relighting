import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

// Calibration cube smoke (real input): an uncalibrated scene shows the stage
// box in its default pose; dragging the lip-right handle with the mouse
// changes the draft and the preview camera and marks the draft dirty; Apply
// commits it; Undo returns to no calibration and the default pose; Redo
// calibrates again; the Stage box toggle hides and shows the box.
test.setTimeout(180_000);

test('stage box: default pose, real drag, apply, undo, redo, toggle', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.setViewportSize({ width: 1600, height: 900 });
  await createSceneFromFixture(page, { name: 'smoke-cube', viewMode: '2d' });
  expect(await page.evaluate(() => window.__state.calibration)).toBeNull();

  // Default pose: the box is visible with its five handles.
  const overlay = page.locator('#cube-overlay');
  await expect(overlay).toBeVisible();
  await expect(overlay.locator('.cube-handle')).toHaveCount(5);
  const before = await page.evaluate(() => {
    const d = window.__calDraft();
    return { lipR: d.draft.marks.lipR.slice(), dist: window.__calPreview().dist_ft, dirty: d.dirty };
  });
  expect(before.dirty).toBe(false);

  // Real mouse drag of the lip-right handle, 60 px to the right.
  const lipR = overlay.locator('.cube-handle[data-key="lipR"]');
  const box = await lipR.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx + i * 10, cy, { steps: 2 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const d = window.__calDraft();
    return { lipR: d.draft.marks.lipR.slice(), dist: window.__calPreview().dist_ft, dirty: d.dirty };
  });
  expect(after.lipR[0]).toBeGreaterThan(before.lipR[0] + 0.02);
  expect(after.dist).not.toBeCloseTo(before.dist, 3);
  expect(after.dirty).toBe(true);
  await expect(page.locator('#calib-panel .cal-apply')).toHaveClass(/is-dirty/);
  await expect(page.locator('#calibrate-btn')).toHaveClass(/is-dirty/);

  // Apply from the panel (the badge opens it on an uncalibrated scene).
  await page.click('#calibrate-btn');
  await expect(page.locator('#calib-panel')).toBeVisible();
  await page.click('#calib-panel .cal-apply');
  await expect.poll(() => page.evaluate(() => window.__state.calibration?.camera?.dist_ft ?? null), { timeout: 15000 }).not.toBeNull();
  const applied = await page.evaluate(() => ({
    dist: window.__state.calibration.camera.dist_ft, preview: window.__calPreview().dist_ft,
    dirty: window.__calDraft().dirty, history: window.__calDraft().history.length, badge: document.getElementById('calibrate-btn').textContent,
  }));
  expect(applied.dist).toBeCloseTo(after.dist, 6);
  expect(applied.preview).toBeCloseTo(applied.dist, 6);
  expect(applied.dirty).toBe(false);
  expect(applied.history).toBe(1);
  expect(applied.badge).not.toBe('Calibrate');
  await expect(page.locator('#calib-panel .cal-apply')).not.toHaveClass(/is-dirty/);

  // Undo → no calibration again, box back to the default pose.
  await page.click('#calib-panel .cal-undo');
  await expect.poll(() => page.evaluate(() => window.__state.calibration), { timeout: 15000 }).toBeNull();
  const undone = await page.evaluate(() => {
    const d = window.__calDraft();
    return { lipR: d.draft.marks.lipR.slice(), redo: !!d.redo, history: d.history.length, badge: document.getElementById('calibrate-btn').textContent };
  });
  expect(undone.lipR[0]).toBeCloseTo(before.lipR[0], 6);
  expect(undone.redo).toBe(true);
  expect(undone.history).toBe(0);
  expect(undone.badge).toBe('Calibrate');

  // Redo → calibrated again with the applied camera.
  await page.click('#calib-panel .cal-redo');
  await expect.poll(() => page.evaluate(() => window.__state.calibration?.camera?.dist_ft ?? null), { timeout: 15000 }).not.toBeNull();
  expect(await page.evaluate(() => window.__state.calibration.camera.dist_ft)).toBeCloseTo(applied.dist, 6);
  expect(await page.evaluate(() => window.__calDraft().redo)).toBeNull();

  // Toggle: with the panel closed and the scene calibrated, the checkbox rules.
  await page.click('#calib-panel .cal-close');
  const stageToggle = page.locator('#show-stage-box');
  await expect(stageToggle).toBeChecked();
  await stageToggle.click();
  await expect(overlay.locator('.cube-stage')).toBeHidden();
  await stageToggle.click();
  await expect(overlay.locator('.cube-stage')).toBeVisible();
  await expect(overlay.locator('.cube-handle')).toHaveCount(5);

  expect(errors, errors.join('\n')).toEqual([]);
});
