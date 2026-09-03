import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

test.setTimeout(180_000);

const CALIBRATION = {
  version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
  marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
  depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null,
};

/** A calibrated scene in split view with a venue, Rig tab open. Returns the console-error sink. */
async function calibratedRigScene(page, name) {
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.setViewportSize({ width: 1600, height: 900 });
  await createSceneFromFixture(page, { name, viewMode: 'split' });
  await page.evaluate((cal) => { window.__state.calibration = cal; window.__applyCalibration(); }, CALIBRATION);
  await expect(page.locator('#calibrate-btn')).toHaveText(/40 × 20 × 30 ft/);
  await page.locator('#tree-pane .pane-tabs button[data-tab="rig"]').click();
  await expect(page.locator('#rig-root .rig-positions tbody tr')).toHaveCount(6);
  return { errors };
}

/**
 * Add a fixture on the venue's second hang position (index 1 — "1E", an
 * onstage pipe) and leave it unaimed: `buildFixtureLight` (ruling T4-B)
 * gives a hung fixture a default direction_ft pointing at stage centre at
 * focus height, so its throw reads a number without the designer assigning
 * an Area first. This is the end-to-end proof that the default-aim fix
 * works — aiming the fixture here (e.g. via the Area select) would mask a
 * regression in that default, which is exactly what an earlier version of
 * this test did before the ruling.
 *
 * Not the first position (FOH, index 0): in this test's calibration FOH's
 * trim/upstage projects outside the photographed frame, so its 2D position
 * handle never renders (isOffFrame in handles.js hides it, an edge-arrow
 * takes its place instead) and `boundingBox()` on it comes back null —
 * confirmed directly (position_eng Y ~= -0.67, outside [0,1]). 1E sits on
 * an onstage pipe and stays on-frame, verified by running this test against
 * both positions before choosing 1E: nothing about the readouts/drag
 * mechanism this test exercises is FOH-specific.
 *
 * `row` is `.first()` on the fixtures table, which is safe here because the
 * hung-position group always renders before the Custom group (where the
 * scene's default Key/Rim lights list), so it resolves to this fixture
 * regardless of how many other rows already exist. Returns the new
 * fixture's light id: the live-drag assertion below needs to select its own
 * handle and cell rather than assuming `.first()` there too — `#handles
 * .handle` is built in `state.lights` order (Key, Rim, ..., this fixture
 * last, per lights.js:236's `tree = [key, rim]` and addFixture's
 * `tree.push`), so a bare `.first()` on the handle would drag Key while
 * watching this fixture's cell. A drag can also detach the fixture from its
 * rig position mid-move (syncDraggedLights -> syncRig -> detachFixture),
 * which triggers a full rig-tab rebuild that moves its row into Custom —
 * an id-based selector keeps following the same light through that rebuild;
 * a position-based one would not.
 */
async function addHungFixture(page) {
  await page.locator('#rig-root .rig-positions tbody tr').nth(1)
    .locator('.rig-actions .rig-btn').first().click();
  const row = page.locator('#rig-root .rig-fixtures tr.rig-fixture').first();
  await expect(row).toHaveCount(1);
  await expect(row.locator('[data-readout="throw"]')).not.toHaveText('—');
  const id = await row.getAttribute('data-id');
  expect(id).toBeTruthy();
  return id;
}

test('readouts: columns populate, and a real-mouse drag moves the throw live', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-readouts');
  const fixtureId = await addHungFixture(page);

  const throwCell = page.locator(`#rig-root tr.rig-fixture[data-id="${fixtureId}"] [data-readout="throw"]`);
  const before = await throwCell.textContent();

  // Calibrate the pointer: screenshot coords are ~10% off on this machine.
  const handle = page.locator(`#handles .handle[data-id="${fixtureId}"]`);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Assert DURING the drag, before release — this is the live guarantee.
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 - 60, { steps: 12 });
  await expect(throwCell).not.toHaveText(before);
  await page.mouse.up();

  expect(errors).toEqual([]);
});

test('ruler 2D: two clicks draw a labelled measurement and a second one persists', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-ruler2d');

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'true');

  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];

  // Pointer calibration probe: coords are ~10% off on this machine.
  await page.mouse.move(...at(0.5, 0.5));

  await page.mouse.click(...at(0.30, 0.62));
  await page.mouse.click(...at(0.70, 0.62));
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(1);

  await page.mouse.click(...at(0.35, 0.55));
  await page.mouse.click(...at(0.65, 0.55));
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(2);

  // Escape exits the tool but keeps what was measured.
  await page.keyboard.press('Escape');
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(2);

  await page.locator('#measure-clear-btn').click();
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(0);

  expect(errors).toEqual([]);
});

test('ruler 2D: the capture layer wins over the stage box handles underneath it', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-capture-order');

  // Stage box is on by default, so its handles sit in the same pane the
  // ruler captures clicks from.
  await expect(page.locator('#show-stage-box')).toBeChecked();
  const before = await page.evaluate(() => {
    const d = window.__calDraft();
    return { lipR: d.draft.marks.lipR.slice(), dirty: d.dirty };
  });
  expect(before.dirty).toBe(false);

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'true');

  // A real drag AT the lip-right cube handle's own position -- the same
  // gesture smoke-cube.spec.js uses to move it. If #measure-capture is above
  // #cube-overlay, this becomes the ruler's first point and the box does not
  // move; if the layers are mis-stacked, the handle drags instead and no
  // ruler point is taken.
  const lipR = page.locator('.cube-handle[data-key="lipR"]');
  const box = await lipR.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(cx + i * 10, cy, { steps: 2 });
  await page.mouse.up();

  const after = await page.evaluate(() => {
    const d = window.__calDraft();
    return { lipR: d.draft.marks.lipR.slice(), dirty: d.dirty };
  });
  expect(after.lipR).toEqual(before.lipR);
  expect(after.dirty).toBe(false);

  // Complete the span with a second, ordinary click. If the first click (at
  // the handle) had been swallowed by the cube handle instead of the ruler,
  // the tool would still be waiting for point A here and this would produce
  // no measurement.
  const wrap = await page.locator('#canvas-wrap').boundingBox();
  await page.mouse.click(wrap.x + wrap.width * 0.5, wrap.y + wrap.height * 0.8);
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(1);

  expect(errors).toEqual([]);
});

test('ruler 2D: Escape mid-span cancels the partial first, then exits on a second press', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-escape');

  await page.locator('#measure-btn').click();
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'true');

  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];
  await page.mouse.move(...at(0.5, 0.5));

  // One point placed, no span committed yet (awaitingB).
  await page.mouse.click(...at(0.4, 0.6));
  await expect(page.locator('#measure-overlay')).not.toHaveAttribute('hidden', '');

  // First Escape: cancels the partial span but stays armed (Task 5's
  // cancel/disarm split -- this is the awaitingB -> cancel() branch, which
  // the two-click "draws a labelled measurement" test never exercises since
  // it always completes each span before pressing Escape).
  await page.keyboard.press('Escape');
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(0);

  // A fresh span still works after the cancel -- the tool really did stay armed.
  await page.mouse.click(...at(0.3, 0.6));
  await page.mouse.click(...at(0.6, 0.6));
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(1);

  // Second Escape: nothing partial left, so this one exits the tool.
  await page.keyboard.press('Escape');
  await expect(page.locator('#measure-btn')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(1);   // kept

  expect(errors).toEqual([]);
});

test('ruler 2D: Measure and Refine Mask exclude each other', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-refine-excl');

  const refineBtn = page.locator('#refine-mask-btn');
  const measureBtn = page.locator('#measure-btn');

  // Refine Mask on, then arm Measure: Refine Mask must actually turn off,
  // not just let the click land somewhere.
  await refineBtn.click();
  await expect(refineBtn).toHaveClass(/active/);
  await expect(page.locator('#refine-overlay')).not.toHaveAttribute('hidden', '');

  await measureBtn.click();
  await expect(measureBtn).toHaveAttribute('aria-pressed', 'true');
  await expect(refineBtn).not.toHaveClass(/active/);
  await expect(page.locator('#refine-overlay')).toHaveAttribute('hidden', '');

  // Reverse direction: Measure already armed (from above), enabling Refine
  // Mask must disarm it -- the other half of the exclusivity guard.
  await refineBtn.click();
  await expect(refineBtn).toHaveClass(/active/);
  await expect(measureBtn).toHaveAttribute('aria-pressed', 'false');

  expect(errors).toEqual([]);
});

test('ruler 3D: two clicks in the viewport draw a measurement', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-ruler3d');

  await page.locator('#measure-btn').click();
  const box = await page.locator('#canvas3d').boundingBox();
  const at = (fx, fy) => [box.x + box.width * fx, box.y + box.height * fy];
  await page.mouse.move(...at(0.5, 0.5));          // calibration probe
  await page.mouse.click(...at(0.35, 0.60));
  await page.mouse.click(...at(0.65, 0.60));

  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);
  expect(errors).toEqual([]);
});

test('measurements clear when the calibration changes or the scene switches', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-clear');

  await page.locator('#measure-btn').click();
  const wrap = await page.locator('#canvas-wrap').boundingBox();
  const at = (fx, fy) => [wrap.x + wrap.width * fx, wrap.y + wrap.height * fy];
  const takeOne = async () => {
    await page.mouse.move(...at(0.5, 0.5));
    await page.mouse.click(...at(0.30, 0.62));
    await page.mouse.click(...at(0.70, 0.62));
  };

  await takeOne();
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);

  // applyCalibration site: a re-apply of the calibration drops them.
  await page.evaluate(() => window.__applyCalibration());
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(0);
  await expect(page.locator('#measure-overlay .measure-label')).toHaveCount(0);

  // adoptVenue site: a venue dims edit re-solves the camera, so it drops
  // them too. Real UI, not window.__state: window.__openVenueEditor is the
  // same console/spec hook main.js already exposes for this modal.
  await takeOne();
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);
  await page.evaluate(() => { window.__openVenueEditor(); });
  await expect(page.locator('.venue-editor')).toBeVisible();
  await page.fill('#ve-width', '41');
  await page.click('#ve-save');
  await expect(page.locator('.venue-editor')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(0);

  // applyScene site: switching to a different scene in the SAME session
  // (not a fresh page load, which would trivially start at 0 regardless of
  // whether the clear() call exists) drops them too. #new-scene-btn is the
  // same trigger smoke.spec.js uses; the popup-fill steps are the same ones
  // helpers.js's createSceneFromFixture uses internally, minus its page.goto
  // -- a reload would replace window.__state's measureTool with a fresh,
  // already-empty instance and prove nothing about this clear() call.
  await takeOne();
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(1);
  const prevScene = await page.evaluate(() => window.__state?.sceneId ?? null);
  await page.click('#new-scene-btn');
  await page.locator('#ns-name').waitFor({ state: 'visible', timeout: 10000 });
  await page.fill('#ns-name', 'smoke-measure-clear-scene2');
  await page.setInputFiles('#ns-file', PORTRAIT_A);
  await page.click('#ns-create');
  await page.waitForFunction((prev) => {
    const s = window.__state;
    return !!s?.sceneId && s.sceneId !== prev && s.width > 0 && s.height > 0;
  }, prevScene, { timeout: 60000 });
  await expect.poll(() => page.evaluate(() => window.__measureCount())).toBe(0);

  expect(errors).toEqual([]);
});
