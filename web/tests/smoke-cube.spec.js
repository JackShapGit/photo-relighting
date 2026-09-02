import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

// Calibration cube smoke (real input): an uncalibrated scene shows the stage
// box in its default pose; dragging the lip-right handle with the mouse
// changes the draft and the preview camera and marks the draft dirty; Apply
// commits it; Undo returns to no calibration and the default pose; Redo
// calibrates again; the Stage box toggle hides and shows the box. Then the
// house box: a real ceiling drag, Apply with a ceiling-referenced pipe, toggle.
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
  await expect(overlay.locator('.cube-stage .cube-handle')).toHaveCount(5);
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
  await expect(overlay.locator('.cube-stage .cube-handle')).toHaveCount(5);

  // ── House box (Task 4): real ceiling drag, Apply with a ceiling-referenced pipe, toggle ──
  const houseToggle = page.locator('#show-house-box');
  await expect(houseToggle).toBeChecked();
  const houseG = overlay.locator('.cube-house');
  await expect(houseG).toBeVisible();
  const ceilHandle = houseG.locator('.cube-house-handle[data-edge="ceiling"]');
  await expect(ceilHandle).toBeVisible();
  const readHouse = () => page.evaluate(() => {
    const d = window.__calDraft();
    return {
      ceiling: d.draft.house.ceiling_ft, estimated: d.draft.house.estimated, dirty: d.dirty,
      label: document.querySelector('#cube-overlay .cube-house .cube-label[data-field="ceiling_ft"]').textContent,
    };
  });
  const hBefore = await readHouse();
  const cb = await ceilHandle.boundingBox();
  const ccx = cb.x + cb.width / 2, ccy = cb.y + cb.height / 2;
  await page.mouse.move(ccx, ccy);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(ccx, ccy - i * 10, { steps: 2 });
  await page.mouse.up();
  const hAfter = await readHouse();
  expect(hAfter.ceiling).toBeGreaterThan(hBefore.ceiling + 0.5);
  expect(hAfter.estimated).toBe(false);
  expect(hAfter.dirty).toBe(true);
  expect(hAfter.label).not.toBe(hBefore.label);

  // A pipe stated against the ceiling keeps its drop when the house is applied.
  await page.evaluate(() => {
    const p = window.__state.venue.positions.find((q) => q.kind === 'pipe');
    p.height_ref = 'ceiling'; p.height_input_ft = 4;
  });
  // The scene is calibrated with a venue now, so the badge opens the venue
  // editor; its Calibration button opens the panel.
  await page.click('#calibrate-btn');
  await page.click('#ve-calibrate');
  await expect(page.locator('#calib-panel')).toBeVisible();
  await page.click('#calib-panel .cal-apply');
  await expect.poll(() => page.evaluate(() => window.__state.venue?.house?.estimated ?? null), { timeout: 15000 }).toBe(false);
  const persisted = await page.evaluate(async () => {
    const s = window.__state;
    const v = await (await fetch(`/venues/${s.venue_id}?workspace=default`)).json();
    const p = v.positions.find((q) => q.kind === 'pipe');
    return { ceiling: v.house.ceiling_ft, estimated: v.house.estimated, trim: p.trim_ft, ref: p.height_ref, input: p.height_input_ft, live: s.venue.house.ceiling_ft, dirty: window.__calDraft().dirty };
  });
  expect(persisted.ceiling).toBeCloseTo(hAfter.ceiling, 3);
  expect(persisted.live).toBeCloseTo(hAfter.ceiling, 3);
  expect(persisted.estimated).toBe(false);
  expect(persisted.ref).toBe('ceiling');
  expect(persisted.input).toBe(4);
  expect(persisted.trim).toBeCloseTo(hAfter.ceiling - 4, 3);
  expect(persisted.dirty).toBe(false);

  // House toggle (panel closed): off hides the house group, on shows it.
  await page.click('#calib-panel .cal-close');
  await houseToggle.click();
  await expect(houseG).toBeHidden();
  await houseToggle.click();
  await expect(houseG).toBeVisible();

  // ── 3D (Task 5): both wireframes in the scene, toggles remove them, dashed while dirty, gizmo on the box ──
  const box3d = (name) => page.evaluate((n) => {
    const o = window.__scene3d?.getObjectByName(n);
    return o ? { material: o.material.type, verts: o.geometry.attributes.position.count, pos: o.position.toArray() } : null;
  }, name);
  await expect.poll(() => box3d('stage-box'), { timeout: 15000 }).not.toBeNull();
  const stage3d = await box3d('stage-box');
  expect(stage3d.verts).toBe(24);
  expect(stage3d.material).toBe('LineBasicMaterial');
  expect(await box3d('house-box')).not.toBeNull();
  await stageToggle.click();
  await expect.poll(() => box3d('stage-box')).toBeNull();
  await stageToggle.click();
  await expect.poll(() => box3d('stage-box')).not.toBeNull();
  await houseToggle.click();
  await expect.poll(() => box3d('house-box')).toBeNull();
  await houseToggle.click();
  await expect.poll(() => box3d('house-box')).not.toBeNull();

  // A real drag on the photo dirties the draft: the 3D boxes go dashed and sit at the draft's offset.
  const lipR2 = overlay.locator('.cube-stage .cube-handle[data-key="lipR"]');
  const b2 = await lipR2.boundingBox();
  const x2 = b2.x + b2.width / 2, y2 = b2.y + b2.height / 2;
  await page.mouse.move(x2, y2);
  await page.mouse.down();
  for (let i = 1; i <= 3; i++) await page.mouse.move(x2 - i * 10, y2, { steps: 2 });
  await page.mouse.up();
  await expect.poll(() => box3d('stage-box').then((o) => o?.material)).toBe('LineDashedMaterial');
  expect(Math.abs((await box3d('stage-box')).pos[2])).toBeGreaterThan(0.01);

  // Panel open with nothing selected: the gizmo sits on the stage box; a
  // selected light takes it (the scene starts with the Key light selected);
  // deselecting gives it back.
  await page.click('#calibrate-btn');
  await page.click('#ve-calibrate');
  await expect(page.locator('#calib-panel')).toBeVisible();
  const gizmoTarget = () => page.evaluate(() => window.__gizmo3d?.object?.name ?? null);
  await page.evaluate(() => { window.__state.selectedId = '__scene__'; window.__onChange(); });
  await expect.poll(gizmoTarget).toBe('stage-box');
  await page.evaluate(() => { window.__state.selectedId = window.__state.lights[0].id; window.__onChange(); });
  await expect.poll(gizmoTarget).not.toBe('stage-box');
  await page.evaluate(() => { window.__state.selectedId = '__scene__'; window.__onChange(); });
  await expect.poll(gizmoTarget).toBe('stage-box');

  // Apply: solid again and back at the origin of the rebuilt frame.
  await page.click('#calib-panel .cal-apply');
  await expect.poll(() => box3d('stage-box').then((o) => o?.material), { timeout: 15000 }).toBe('LineBasicMaterial');
  // The offset resets once applyCalibration runs (after the venue write), not on the Apply click itself.
  await expect.poll(() => box3d('stage-box').then((o) => Math.abs(o?.pos[2] ?? 1)), { timeout: 15000 }).toBeLessThan(1e-6);
  await page.click('#calib-panel .cal-close');

  expect(errors, errors.join('\n')).toEqual([]);
});
