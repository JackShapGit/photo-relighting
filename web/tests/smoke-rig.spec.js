import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { createSceneFromFixture, PORTRAIT_A } from './helpers.js';

// Rig smoke (Spec 2): a calibrated scene referencing a venue created through
// the API opens on the Rig tab with the venue's six starter positions; a real
// click on the FOH row's "+" adds a fixture hung on that position; the 3D
// viewport carries the rig overlay; the 64-emitter cap refuses a 65th enable
// with the spec's message. Everything the test creates lands in the
// Playwright server's own DB (web/tests/cache/scenes.db, gitignored): the
// webServer command runs with the config file's directory as cwd, so the
// API's default RELIGHT_SCENES_DB / RELIGHT_CACHE_DIR resolve there, not in
// the project's cache/.
test.setTimeout(180_000);

const CALIBRATION = {
  version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
  marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
  depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null,
};

test('rig tab: venue positions, add fixture, 3D overlay, 64-light cap', async ({ page }) => {
  test.skip(!fs.existsSync(PORTRAIT_A), 'fixture missing');
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  // Room for the 670 px Rig pane, the stage, and the props pane.
  await page.setViewportSize({ width: 1600, height: 900 });
  await createSceneFromFixture(page, { name: 'smoke-rig', viewMode: 'split' });
  const sceneId = await page.evaluate(() => window.__state.sceneId);

  // Calibrate exactly as smoke-calibrated.spec.js does (this also migrates a
  // venue named after the scene; the test then points the scene at its own).
  await page.evaluate((cal) => {
    window.__state.calibration = cal;
    window.__applyCalibration();
  }, CALIBRATION);
  await expect(page.locator('#calibrate-btn')).toHaveText(/40 × 20 × 30 ft/);

  // A venue through the API: the synthetic house, starter positions filled by the server.
  const created = await page.request.post('http://localhost:8765/venues', {
    data: {
      name: 'smoke-rig house', width_ft: 40, height_ft: 20, depth_ft: 30,
      grid: { rows: 3, cols: 3, number_from_stage_left: false }, focus_height_ft: 5, positions: [],
    },
  });
  expect(created.ok()).toBe(true);
  const venue = await created.json();
  expect(venue.positions).toHaveLength(6);

  // Point the scene at it through the normal save path, then reload.
  await page.evaluate((v) => {
    const s = window.__state;
    s.venue_id = v.id; s.venue = v; s.venue_snapshot = v; s.venueMissing = false;
    window.__onChange();
  }, venue);
  await expect.poll(async () => {
    const r = await page.request.get(`http://localhost:8765/scenes/${sceneId}`);
    return (await r.json()).state?.venue_id;
  }, { timeout: 15000 }).toBe(venue.id);
  await page.reload();
  await page.waitForFunction((id) => window.__state?.venue?.id === id && !!window.__state.calibration?.camera, venue.id, { timeout: 60000 });

  // Rig tab enabled and selected; six positions listed.
  const rigTab = page.locator('#tree-pane .pane-tabs button[data-tab="rig"]');
  await expect(rigTab).toHaveAttribute('aria-disabled', 'false');
  await expect(rigTab).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#rig-root .rig-positions tbody tr')).toHaveCount(6);
  await expect(page.locator('#rig-root .rig-status')).toContainText('venue: smoke-rig house');

  // Real click on the FOH truss row's "+" → one more fixture row (the scene's
  // default Key/Rim lights already list under Custom), hung on that position.
  const rowsBefore = await page.locator('#rig-root .rig-fixtures tr.rig-fixture').count();
  await page.locator('#rig-root .rig-positions tbody tr').first().locator('.rig-actions .rig-btn').first().click();
  await expect(page.locator('#rig-root .rig-fixtures tr.rig-fixture')).toHaveCount(rowsBefore + 1);
  await expect(page.locator('#rig-root .rig-fixtures tr.rig-group').first()).toContainText('FOH truss (1)');
  const hung = await page.evaluate((fohId) => {
    const L = window.__state.lights.find((l) => l.fixture?.position_id === fohId);
    return L && { name: L.name, pos: L.position_ft, type: L.fixture.type };
  }, venue.positions[0].id);
  expect(hung).toBeTruthy();
  expect(hung.type).toBe('ers');
  expect(hung.pos[1]).toBeCloseTo(22, 5);      // FOH truss trim = opening height + 2
  expect(hung.pos[2]).toBeCloseTo(-39, 5);     // −depth × 1.3

  // The fixtures table fits the default pane width without a horizontal scroll.
  const fit = await page.evaluate(() => {
    const w = document.querySelectorAll('#rig-root .rig-table-wrap')[1];
    return { scroll: w.scrollWidth, client: w.clientWidth };
  });
  expect(fit.scroll).toBeLessThanOrEqual(fit.client);

  // 3D: the rig overlay is built with the stage (async point-cloud load).
  await page.waitForFunction(() => !!window.__scene3d?.getObjectByName('rig-overlay'), null, { timeout: 60000 });
  const overlay = await page.evaluate(() => {
    const ov = window.__scene3d.getObjectByName('rig-overlay');
    let labels = 0, bars = 0;
    ov.traverse((o) => { if (o.name === 'rig-area-label') labels++; if (o.name === 'rig-position-bar') bars++; });
    return { labels, bars };
  });
  expect(overlay).toEqual({ labels: 9, bars: 6 });

  // Cap: fill to 64 enabled with the exported pure builder, plus one disabled.
  const offId = await page.evaluate(() => {
    const s = window.__state;
    const enabled = s.lights.filter((l) => l.type !== 'reflector' && l.enabled !== false).length;
    const ps = s.venue.positions;
    for (let i = 0; i < 64 - enabled; i++) {
      const p = ps[1 + (i % 3)];
      const L = window.__rig.buildFixtureLight(s.venue, p, 'ers', window.__rig.nextOffset(s.lights, p.id), i + 1);
      L.name = `Cap-${i + 1}`;
      s.tree.push(L); s.lights.push(L);
    }
    const off = window.__rig.buildFixtureLight(s.venue, ps[4], 'ers', 5, 1);
    off.name = 'Cap-65'; off.enabled = false;
    s.tree.push(off);
    window.__onChange();
    return off.id;
  });
  await expect(page.locator('#rig-root .rig-status')).toContainText('64 of 64 enabled');
  const box = page.locator(`#rig-root [data-key="fix:${offId}:on"]`);
  await box.scrollIntoViewIfNeeded();
  await box.click();
  await expect(box).not.toBeChecked();
  await expect(page.locator('#rig-root .rig-msg')).toHaveText('64 lights maximum; disable one first');
  expect(await page.evaluate(() => window.__state.lights.filter((l) => l.type !== 'reflector' && l.enabled !== false).length)).toBe(64);

  // The props pane shares the gate: select the disabled light, click its
  // Enabled checkbox → refused with the same message.
  // Row click = anywhere that is not a control: the cell padding next to the offset input.
  await page.locator(`#rig-root tr[data-id="${offId}"] td:nth-child(5)`).click({ position: { x: 2, y: 3 } });
  await expect(page.locator('#props-pane .props-name')).toHaveText('Cap-65');
  const propsBox = page.locator('#props-pane .enabled');
  await propsBox.click();
  await expect(propsBox).not.toBeChecked();
  await expect(page.locator('#props-pane .props-msg')).toHaveText('64 lights maximum; disable one first');
  expect(await page.evaluate(() => window.__state.lights.filter((l) => l.type !== 'reflector' && l.enabled !== false).length)).toBe(64);

  expect(errors, errors.join('\n')).toEqual([]);
});
