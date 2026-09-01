import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { createSceneFromFixture } from './helpers.js';

const FIXTURE = path.resolve('packages/relighting_engine/tests/fixtures/images/portrait_a.jpg');
const GOLDEN = path.resolve('packages/relighting_engine/tests/fixtures/expected/portrait_a__single_directional.png');
const GOLDEN_CAL = path.resolve('packages/relighting_engine/tests/fixtures/expected/portrait_a__calibrated_foh_spot.png');

// Tolerance for WebGL vs Python: per-pixel YIQ threshold 0.1, at most 2 % of
// pixels may differ. The goldens under fixtures/expected are the snapshots
// (see snapshotPathTemplate in playwright.config.js); the names are passed as
// path segments because a string name gets its underscores sanitized to dashes.
const PARITY = { maxDiffPixelRatio: 0.02, threshold: 0.1 };

// Each parity test runs a real /prepare (depth + segmentation) and builds the
// 3D point cloud under software GL; the default 30 s budget is too tight and
// a page.evaluate can block for several seconds while the cloud is built.
test.setTimeout(120_000);
const t0 = Date.now();
const mark = (label) => console.log(`[parity +${((Date.now() - t0) / 1000).toFixed(1)}s] ${label}`);

// Create a scene from the fixture (shared helper: new-scene popup, wait for
// the scene id to change) and size the viewport for a pixel-exact capture.
async function uploadFixture(page) {
  // 2D-only view so the photo canvas gets the whole stage (the default Split
  // mode halves it and the capture would be letterboxed to ~130 px wide).
  await createSceneFromFixture(page, { fixture: FIXTURE, name: 'parity', viewMode: '2d' });

  // Size the viewport so the stage is exactly imgW × imgH: measure the chrome
  // around #stage (header, tree pane, props pane, borders) instead of assuming
  // fixed widths, then let fitCanvasWrap letterbox to the image aspect, which
  // at an exact match yields a canvas of imgW × imgH — the golden's size.
  const { imgW, imgH, extraW, extraH } = await page.evaluate(() => {
    const st = document.getElementById('stage').getBoundingClientRect();
    return {
      imgW: window.__state.width, imgH: window.__state.height,
      extraW: Math.round(window.innerWidth - st.width),
      extraH: Math.round(window.innerHeight - st.height),
    };
  });
  await page.setViewportSize({ width: imgW + extraW, height: imgH + extraH });
  await page.waitForFunction(({ w, h }) => {
    const c = document.getElementById('canvas');
    return c.width === w && c.height === h;
  }, { w: imgW, h: imgH }, { timeout: 10000 });
  mark(`scene ready, canvas ${imgW}x${imgH}`);
}

// Re-render with the current window.__state (main.js exposes window.__redraw).
const REDRAW = `window.__redraw()`;

async function captureCanvas(page, fileName) {
  // Read canvas pixels via toDataURL — gets exactly what WebGL rendered at
  // the canvas's native pixel dimensions (imgW × imgH after viewport resize).
  // The canvas is sRGB-encoded by relight.frag, like the Python goldens.
  const dataUrl = await page.evaluate(() =>
    document.getElementById('canvas').toDataURL('image/png')
  );
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  const webglPng = Buffer.from(base64, 'base64');
  // Keep a copy for debugging diffs by hand.
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
  mark('lights applied + redraw');
  await page.waitForTimeout(300);

  const webglPng = await captureCanvas(page, 'webgl.png');
  expect(webglPng).toMatchSnapshot(['portrait_a__single_directional.png'], PARITY);
});

// Calibrated (metric) parity: same structure, feet-space light, driven through
// window.__applyCalibration / __syncMetricLights / __redraw from main.js.
test('WebGL calibrated render matches Python golden within tolerance', async ({ page }) => {
  test.skip(!fs.existsSync(FIXTURE) || !fs.existsSync(GOLDEN_CAL), 'fixtures missing');

  await uploadFixture(page);

  // Matches the "calibrated_foh_spot" golden config in configs.py.
  await page.evaluate(() => {
    const s = window.__state;
    s.calibration = { version: 1, units: 'ft', width_ft: 40, height_ft: 20, depth_ft: 30,
      marks: { lipL: [0.1, 0.61333], lipR: [0.9, 0.61333], top: [0.5, 0.08], backL: [0.23333, 0.54222], backR: [0.76667, 0.54222] },
      depth_fit: { a: -0.027778, b: 0.030556 }, depth_check: null };
    window.__applyCalibration();   // solves the camera, syncs lights
    s.lights = [{ type: 'spotlight', position: [0.5, 0.2, 1.0], direction: [0, 0.3, -1],
      position_ft: [0, 20, -60], target_ft: [0, 5, 10], intensity: 6.0, falloff: 1.0,
      cone_angle: 0.6, softness: 0.1, color: [1,1,1], color_temperature: null, gel_preset: null,
      gobo: null, affects: 'all', enabled: true }];
    window.__syncMetricLights();
    s.ambient = 0.1;
    window.__redraw();
  });
  mark('calibrated lights applied + redraw');
  await page.waitForTimeout(300);

  const webglPng = await captureCanvas(page, 'webgl_calibrated.png');
  expect(webglPng).toMatchSnapshot(['portrait_a__calibrated_foh_spot.png'], PARITY);
});
