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
 * onstage pipe) and aim it through the app's own mechanism (the Area
 * select) so its throw is deterministic: `buildFixtureLight` creates every
 * fixture unaimed (`fixture.area = null`), and an unaimed fixture's throw
 * depends on whatever `direction_ft` it inherited by default — not
 * something a test should rely on. Area 5 is the centre cell of the 3x3
 * grid; setFixtureArea gives the fixture a target_ft of
 * areaCenter(venue, '5'), i.e. [0, focus_height_ft, Z] — deterministic.
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
async function addAimedFixture(page) {
  await page.locator('#rig-root .rig-positions tbody tr').nth(1)
    .locator('.rig-actions .rig-btn').first().click();
  const row = page.locator('#rig-root .rig-fixtures tr.rig-fixture').first();
  await expect(row).toHaveCount(1);
  await row.locator('select[data-key$=":area"]').selectOption('5');
  await expect(row.locator('[data-readout="throw"]')).not.toHaveText('—');
  const id = await row.getAttribute('data-id');
  expect(id).toBeTruthy();
  return id;
}

test('readouts: columns populate, and a real-mouse drag moves the throw live', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const { errors } = await calibratedRigScene(page, 'smoke-measure-readouts');
  const fixtureId = await addAimedFixture(page);

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
