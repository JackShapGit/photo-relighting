// Shared Playwright helpers (not a spec: the file name keeps it out of testMatch).
import path from 'node:path';

export const PORTRAIT_A = path.resolve('packages/relighting_engine/tests/fixtures/images/portrait_a.jpg');

/**
 * Create a scene from an image through the new-scene popup and wait until
 * the playground has loaded it. The popup opens by itself only when the
 * server has no scenes; once a previous run has created one, it is opened
 * with "+ New Scene". The Create button only enables once both a name and a
 * file are set.
 *
 * When a previous run's scene auto-loaded, __state already has a width, so
 * this waits for the scene id to change rather than for width alone;
 * otherwise the late applyScene would overwrite anything the test sets.
 *
 * @param {import('@playwright/test').Page} page
 * @param {{ fixture?: string, name?: string, viewMode?: '2d'|'split'|'3d'|null }} [o]
 *   viewMode is stored before navigation (null leaves the stored preference).
 */
export async function createSceneFromFixture(page, { fixture = PORTRAIT_A, name = 'e2e', viewMode = null } = {}) {
  if (viewMode) {
    await page.addInitScript((mode) => { try { localStorage.setItem('photo-relight:view-mode', mode); } catch {} }, viewMode);
  }
  await page.goto('http://localhost:8765/web/playground.html');
  const popupOpen = await page.locator('#ns-name').waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true, () => false);
  if (!popupOpen) {
    await page.click('#new-scene-btn');
    await page.locator('#ns-name').waitFor({ state: 'visible', timeout: 10000 });
  }
  const prevScene = await page.evaluate(() => window.__state?.sceneId ?? null);
  await page.fill('#ns-name', name);
  await page.setInputFiles('#ns-file', fixture);
  await page.click('#ns-create');
  await page.waitForFunction((prev) => {
    const s = window.__state;
    return !!s?.sceneId && s.sceneId !== prev && s.width > 0 && s.height > 0;
  }, prevScene, { timeout: 60000 });
  // applyScene sets width before its awaited renderer/texture setup; give it a
  // moment to finish before touching state.
  await page.waitForTimeout(1500);
}
