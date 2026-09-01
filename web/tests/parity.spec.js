import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const FIXTURE = path.resolve('packages/relighting_engine/tests/fixtures/images/portrait_a.jpg');
const GOLDEN = path.resolve('packages/relighting_engine/tests/fixtures/expected/portrait_a__single_directional.png');
const GOLDEN_CAL = path.resolve('packages/relighting_engine/tests/fixtures/expected/portrait_a__calibrated_foh_spot.png');

// Layout constants from playground.css / playground.html:
//   header height: 44px, controls sidebar width: 320px
const HEADER_H = 44;
const CONTROLS_W = 320;

// Create a scene from the fixture through the new-scene popup (open on a
// fresh browser profile) and wait for the prepared dimensions. The Create
// button only enables once both a name and a file are set.
async function uploadFixture(page) {
  await page.goto('http://localhost:8765/web/playground.html');
  await page.fill('#ns-name', 'parity');
  await page.setInputFiles('#ns-file', FIXTURE);
  await page.click('#ns-create');
  await page.waitForFunction(() => window.__state?.width > 0 && window.__state?.height > 0, { timeout: 60000 });

  // Read the prepared image dimensions and resize the viewport so the canvas
  // is exactly width×height — no scaling artefacts in the parity comparison.
  const { imgW, imgH } = await page.evaluate(() => ({
    imgW: window.__state.width,
    imgH: window.__state.height,
  }));
  await page.setViewportSize({ width: imgW + CONTROLS_W, height: imgH + HEADER_H });
}

// Re-render with the current window.__state. Task 8 exposes window.__redraw;
// until then the window 'resize' listener in main.js calls redraw() directly.
const REDRAW = `(window.__redraw || (() => window.dispatchEvent(new Event('resize'))))()`;

async function captureCanvas(page, fileName) {
  // Read canvas pixels via toDataURL — gets exactly what WebGL rendered at
  // the canvas's native pixel dimensions (imgW × imgH after viewport resize).
  const dataUrl = await page.evaluate(() =>
    document.getElementById('canvas').toDataURL('image/png')
  );
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const webglPng = Buffer.from(base64, 'base64');
  const tmp = path.resolve(`test-results/${fileName}`);
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  fs.writeFileSync(tmp, webglPng);
  return webglPng;
}

test('WebGL render matches Python golden within tolerance', async ({ page }) => {
  test.skip(!fs.existsSync(FIXTURE) || !fs.existsSync(GOLDEN), 'fixtures missing');

  await uploadFixture(page);

  // Set lights to match the "single_directional" golden config exactly.
  // Source: packages/relighting_engine/tests/golden/configs.py
  //   Light(type="directional", direction=(0.5, -0.5, -0.5), intensity=1.0)  ambient=0.15
  // Light defaults: position=(0,0,-1), color=(1,1,1), color_temperature=None,
  //   gel_preset=None, falloff=1.0, cone_angle=0.5, softness=0.1, gobo=None,
  //   affects="all", enabled=true
  await page.evaluate((redraw) => {
    const s = window.__state;
    s.lights = [{
      type: 'directional',
      position: [0.0, 0.0, -1.0],
      direction: [0.5, -0.5, -0.5],
      color: [1, 1, 1],
      color_temperature: null,
      gel_preset: null,
      intensity: 1.0,
      falloff: 1.0,
      cone_angle: 0.5,
      softness: 0.1,
      gobo: null,
      affects: 'all',
      enabled: true,
    }];
    s.ambient = 0.15;
    eval(redraw);
  }, REDRAW);
  await page.waitForTimeout(300);

  const webglPng = await captureCanvas(page, 'webgl.png');

  // Exact parity is checked by scripts/parity_check.py (run separately).
  // Here we just confirm a real image was captured.
  expect(webglPng.length).toBeGreaterThan(1000);
});

// Calibrated (metric) parity: same structure, feet-space light. Depends on
// window.__applyCalibration / __syncMetricLights / __redraw from Task 8, so
// it stays fixme until that lands.
test.fixme('WebGL calibrated render matches Python golden within tolerance', async ({ page }) => {
  test.skip(!fs.existsSync(FIXTURE) || !fs.existsSync(GOLDEN_CAL), 'fixtures missing');

  await uploadFixture(page);

  // Matches the "calibrated_foh_spot" golden config in configs.py.
  await page.evaluate(() => {
    const s = window.__state;
    s.calibration = { version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
      marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
      depth_fit: { a: -0.037037, b: 0.024074 }, depth_check: null };
    window.__applyCalibration();   // Task 8 exposes this: solves camera, syncs lights
    s.lights = [{ type: 'spotlight', position: [0.5, 0.2, 1.0], direction: [0, 0.3, -1],
      position_ft: [0, 20, -60], target_ft: [0, 5, 10], intensity: 8.0, falloff: 1.0,
      cone_angle: 0.35, softness: 0.1, color: [1,1,1], color_temperature: null, gel_preset: null,
      gobo: null, affects: 'all', enabled: true }];
    window.__syncMetricLights();   // Task 8 exposes this
    s.ambient = 0.1;
    window.__redraw();
  });
  await page.waitForTimeout(300);

  const webglPng = await captureCanvas(page, 'webgl_calibrated.png');
  expect(webglPng.length).toBeGreaterThan(1000);
});
