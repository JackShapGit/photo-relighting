import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateMarks, solveCamera, pixelToWorld, worldToPixel, fitDepth,
  depthToZcam, zcamToDepth, worldToEngine, engineToWorld,
  engineDirToWorld, worldDirToEngine, falloffToMetric, effectiveFit, SYNTHETIC_STAGE,
} from '../../../src/metric/calibration.js';

const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const nearPct = (a, b, pct) => assert.ok(Math.abs(a - b) <= Math.abs(b) * pct / 100, `${a} !~ ${b} (${pct}%)`);

const { record, aspect, expected } = SYNTHETIC_STAGE;

test('validateMarks accepts the synthetic stage', () => {
  assert.deepEqual(validateMarks(record), { ok: true, errors: [] });
});

test('validateMarks rejects lip points too close', () => {
  const r = { ...record, marks: { ...record.marks, lipR: [0.13, 0.61333] } };
  const v = validateMarks(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /lip/i.test(e)));
});

test('validateMarks rejects top mark below the lip line', () => {
  const r = { ...record, marks: { ...record.marks, top: [0.5, 0.7] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects back line wider than or equal to lip', () => {
  const r = { ...record, marks: { ...record.marks, backL: [0.05, 0.54], backR: [0.95, 0.54] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects back line below the lip line', () => {
  const r = { ...record, marks: { ...record.marks, backL: [0.3, 0.7], backR: [0.7, 0.7] } };
  assert.equal(validateMarks(r).ok, false);
});

test('validateMarks rejects non-positive dimensions', () => {
  assert.equal(validateMarks({ ...record, depth_ft: 0 }).ok, false);
});

test('solveCamera recovers the synthetic camera', () => {
  const cam = solveCamera(record, aspect);
  nearPct(cam.dist_ft, expected.dist_ft, 0.5);
  nearPct(cam.height_ft, expected.height_ft, 0.5);
  nearPct(cam.f, expected.f, 0.5);
  near(cam.k_y, 1.0, 0.01);
  near(cam.u_c, 0.5, 1e-9);
  near(cam.va_h, 0.3, 0.002);
  assert.ok(cam.height_check_pct < 1);
  near(cam.perspective_ratio, 2 / 3, 1e-3);
});

test('solveCamera flags a shallow stage via perspective_ratio', () => {
  // 10 ft deep stage seen from 60 ft: back line is 60/70 of the lip width.
  const shallow = { ...record, depth_ft: 10, marks: { ...record.marks, backL: [0.5 - 0.4 * 60 / 70, 0.6], backR: [0.5 + 0.4 * 60 / 70, 0.6] } };
  const cam = solveCamera(shallow, aspect);
  nearPct(cam.dist_ft, 60, 1);
  assert.ok(cam.perspective_ratio > 0.85);
});

test('pixelToWorld puts the lip corners on the deck at ±20 ft, Z = 0', () => {
  const cam = solveCamera(record, aspect);
  const L = pixelToWorld(record.marks.lipL[0], record.marks.lipL[1], cam.dist_ft, cam);
  const R = pixelToWorld(record.marks.lipR[0], record.marks.lipR[1], cam.dist_ft, cam);
  nearPct(L[0], -20, 0.5); near(L[1], 0, 0.05); near(L[2], 0, 1e-6);
  nearPct(R[0], 20, 0.5);
});

test('pixelToWorld puts the top mark at Y = 20 ft', () => {
  const cam = solveCamera(record, aspect);
  const T = pixelToWorld(record.marks.top[0], record.marks.top[1], cam.dist_ft, cam);
  nearPct(T[1], 20, 0.5);
});

test('pixelToWorld puts the back line at Z = 30 ft on the deck', () => {
  const cam = solveCamera(record, aspect);
  const B = pixelToWorld(record.marks.backL[0], record.marks.backL[1], cam.dist_ft + 30, cam);
  nearPct(B[0], -20, 0.5); near(B[1], 0, 0.05); near(B[2], 30, 1e-6);
});

test('worldToPixel inverts pixelToWorld and is null behind the camera', () => {
  const cam = solveCamera(record, aspect);
  const p = [7, 3, 12];
  const [u, v, zc] = worldToPixel(p, cam);
  const back = pixelToWorld(u, v, zc, cam);
  near(back[0], 7, 1e-6); near(back[1], 3, 1e-6); near(back[2], 12, 1e-6);
  assert.equal(worldToPixel([0, 10, -60], cam), null);     // at the camera
  assert.equal(worldToPixel([0, 10, -80], cam), null);     // behind it
});

test('fitDepth solves a and b from lip/back medians', () => {
  const cam = solveCamera(record, aspect);
  const sample = (u, v) => (v > 0.6 ? 0.20 : 0.35);        // lip line lower in image than back line
  const fit = fitDepth(record, cam, sample);
  near(fit.a, -0.037037, 1e-5);
  near(fit.b, 0.024074, 1e-5);
  // The fit is anchored on the solved camera (dist_ft = 60.00225 from the
  // 5-decimal synthetic marks), so check against it rather than the ideal 60/90.
  const zLip = cam.dist_ft;
  const zBack = cam.dist_ft + record.depth_ft;
  nearPct(zLip, 60, 0.01);
  near(depthToZcam(0.20, fit), zLip, 1e-3);
  near(depthToZcam(0.35, fit), zBack, 1e-3);
  near(zcamToDepth(zBack, fit), 0.35, 1e-6);
});

test('fitDepth returns null on flat depth', () => {
  const cam = solveCamera(record, aspect);
  assert.equal(fitDepth(record, cam, () => 0.3), null);
});

test('depthToZcam clamps to [0.5, 10000]', () => {
  const fit = { a: -0.037037, b: 0.024074 };
  assert.ok(depthToZcam(0.65, fit) <= 10000);
  assert.ok(depthToZcam(-5, fit) >= 0.5);
});

test('worldToEngine / engineToWorld round trip inside the frame', () => {
  const cam = solveCamera(record, aspect);
  const fit = { a: -0.037037, b: 0.024074 };
  const w = [5, 4, 10];
  const e = worldToEngine(w, cam, fit);
  assert.ok(e[0] > 0 && e[0] < 1 && e[1] > 0 && e[1] < 1);
  const back = engineToWorld(e, cam, fit);
  near(back[0], 5, 1e-6); near(back[1], 4, 1e-6); near(back[2], 10, 1e-6);
  assert.equal(worldToEngine([0, 20, -70], cam, fit), null);
});

test('direction transforms flip y and z', () => {
  assert.deepEqual(engineDirToWorld([0.1, 0.2, -0.9]), [0.1, -0.2, 0.9]);
  assert.deepEqual(worldDirToEngine([0.1, -0.2, 0.9]), [0.1, 0.2, -0.9]);
});

test('falloffToMetric divides by width squared', () => {
  near(falloffToMetric(1.0, record), 1 / 1600, 1e-12);
});

// ── No depth fit: linear fallback (spec §Error handling) ──
// zCam = dist_ft + d·depth_ft, the same rule the shader applies when u_fit.z = 0.

test('effectiveFit returns the fitted a/b when present, else a linear descriptor', () => {
  const cam = solveCamera(record, aspect);
  const fitted = { ...record, camera: cam, depth_fit: { a: -0.037037, b: 0.024074 } };
  assert.deepEqual(effectiveFit(fitted), { a: -0.037037, b: 0.024074 });
  const lin = effectiveFit({ ...record, camera: cam, depth_fit: null });
  assert.equal(lin.linear, true);
  near(lin.dist_ft, cam.dist_ft, 1e-12);
  near(lin.depth_ft, 30, 1e-12);
});

test('depthToZcam linear: d = 0 is the lip plane, d = 1 is the back line', () => {
  const cam = solveCamera(record, aspect);
  const lin = effectiveFit({ ...record, camera: cam, depth_fit: null });
  near(depthToZcam(0, lin), cam.dist_ft, 1e-9);
  near(depthToZcam(1, lin), cam.dist_ft + 30, 1e-9);
  assert.ok(depthToZcam(-1000, lin) >= 0.5 && depthToZcam(1e6, lin) <= 10000, 'still clamped');
});

test('zcamToDepth / depthToZcam and worldToEngine / engineToWorld round trip with the linear fit', () => {
  const cam = solveCamera(record, aspect);
  const lin = effectiveFit({ ...record, camera: cam, depth_fit: null });
  near(zcamToDepth(depthToZcam(0.37, lin), lin), 0.37, 1e-9);
  const w = [5, 4, 10];
  const e = worldToEngine(w, cam, lin);
  assert.ok(e[0] > 0 && e[0] < 1 && e[1] > 0 && e[1] < 1);
  near(e[2], 1 - 10 / 30, 1e-9);                     // Z = 10 ft of a 30 ft stage → d = 1/3
  const back = engineToWorld(e, cam, lin);
  near(back[0], 5, 1e-6); near(back[1], 4, 1e-6); near(back[2], 10, 1e-6);
  assert.equal(worldToEngine([0, 20, -70], cam, lin), null);
});
