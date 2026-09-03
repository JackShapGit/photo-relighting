import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stageCorners, guessCamera, handlePoints, marksFromCamera, applyHandleDrag, clampStageDrag,
  houseEdgesPx, housePxToFt, clampHouse, cameraFromGizmoDelta, MIN_LIP_FRACTION,
  houseForDims, houseDragPatch, houseWidthPatch, cameraDelta,
} from '../../../src/metric/cube-geometry.js';
import { defaultHouse } from '../../../src/rig/geometry.js';
import { solveCamera, validateMarks, worldToPixel, SYNTHETIC_STAGE, Z_CAM_MIN } from '../../../src/metric/calibration.js';

const { record, aspect } = SYNTHETIC_STAGE;
const DIMS = { width_ft: record.width_ft, height_ft: record.height_ft, depth_ft: record.depth_ft };
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b} (tol ${tol})`);
const vnear = (a, b, tol = 1e-6) => { assert.equal(a.length, b.length); a.forEach((v, i) => near(v, b[i], tol)); };

test('stageCorners: the box [±W/2, {0,H}, {0,D}] in world feet', () => {
  const c = stageCorners(DIMS);
  assert.deepEqual(c.fbl, [-20, 0, 0]); assert.deepEqual(c.fbr, [20, 0, 0]);
  assert.deepEqual(c.ftl, [-20, 20, 0]); assert.deepEqual(c.ftr, [20, 20, 0]);
  assert.deepEqual(c.bbl, [-20, 0, 30]); assert.deepEqual(c.bbr, [20, 0, 30]);
  assert.deepEqual(c.btl, [-20, 20, 30]); assert.deepEqual(c.btr, [20, 20, 30]);
});

test('guessCamera: dist 1.5·W, height 6, lip spans up to 70% of the width at v 0.72, marks valid (aspect 0.75 and 0.5625)', () => {
  for (const asp of [0.75, 0.5625]) {
    const cam = guessCamera(DIMS, asp);
    assert.equal(cam.dist_ft, 60); assert.equal(cam.height_ft, 6); assert.equal(cam.u_c, 0.5); assert.equal(cam.k_y, 1);
    assert.equal(cam.aspect, asp);
    if (asp === 0.75) near(cam.f, 0.7 * 60 / 40); else assert.ok(cam.f <= 0.7 * 60 / 40 + 1e-9, 'f capped so the top stays inside');
    const marks = marksFromCamera(cam, DIMS);
    if (asp === 0.75) near(marks.lipR[0] - marks.lipL[0], 0.7); else assert.ok(marks.lipR[0] - marks.lipL[0] <= 0.7 + 1e-9);
    near(marks.lipL[1], 0.72); near(marks.lipR[1], 0.72);
    near(marks.top[0], 0.5);
    assert.deepEqual(validateMarks({ ...DIMS, marks }), { ok: true, errors: [] });
    assert.ok(marks.top[1] > 0 && marks.backL[1] > 0, 'top and back stay inside the image');
  }
});

test('round trip: marks → solveCamera → handlePoints reproduces the synthetic marks within 1e-6', () => {
  const cam = solveCamera(record, aspect);
  const back = handlePoints(cam, DIMS);
  for (const k of ['lipL', 'lipR', 'top', 'backL', 'backR']) vnear(back[k], record.marks[k], 1e-6);
  assert.deepEqual(marksFromCamera(cam, DIMS), back);
});

test('handlePoints: top is [u_c, v of the front-top edge midpoint]', () => {
  const cam = solveCamera(record, aspect);
  const hp = handlePoints(cam, DIMS);
  const mid = worldToPixel([0, DIMS.height_ft, 0], cam);
  near(hp.top[0], cam.u_c); near(hp.top[1], mid[1]);
});

test('applyHandleDrag copies the marks, moves one handle, keeps top at u_c', () => {
  const m = record.marks;
  const moved = applyHandleDrag(m, 'top', [0.3, 0.2]);
  assert.notEqual(moved, m); assert.deepEqual(m.top, [0.5, 0.08], 'input untouched');
  near(moved.top[0], 0.5); near(moved.top[1], 0.2);
  const lip = applyHandleDrag(m, 'lipR', [0.85, 0.62]);
  vnear(lip.lipR, [0.85, 0.62]); assert.deepEqual(lip.lipL, m.lipL);
  near(applyHandleDrag(lip, 'top', [0.9, 0.1]).top[0], (0.1 + 0.85) / 2, 1e-9);
});

test('clampStageDrag keeps every drag inside what validateMarks accepts', () => {
  const m = record.marks;
  const wLip = m.lipR[0] - m.lipL[0];
  // backR cannot widen the back line to the lip width. On the synthetic
  // stage that limit (1.03) lies outside the image, so a drag to 0.95 is in
  // range and passes through; the `narrow` marks below exercise the limit.
  const br = clampStageDrag(m, 'backR', [0.95, 0.54222]);
  assert.ok(br[0] < m.backL[0] + wLip, 'back stays narrower than the lip');
  vnear(br, [0.95, 0.54222]);
  const narrow = { lipL: [0.3, 0.7], lipR: [0.7, 0.7], top: [0.5, 0.2], backL: [0.35, 0.6], backR: [0.6, 0.6] };
  const nbr = clampStageDrag(narrow, 'backR', [0.9, 0.6]);
  near(nbr[0], 0.35 + 0.98 * 0.4, 1e-9);            // the back stays below 98 % of the lip width
  assert.ok(nbr[0] < 0.75, 'strictly narrower than the lip');
  // top cannot cross the lip line.
  const top = clampStageDrag(m, 'top', [0.5, 0.9]);
  assert.ok(top[1] < m.lipL[1]);
  // lipR keeps at least 5% of the width from lipL (and stays outside the back line).
  const lr = clampStageDrag(m, 'lipR', [0.11, 0.61333]);
  assert.ok(lr[0] - m.lipL[0] >= MIN_LIP_FRACTION - 1e-9);
  assert.ok(lr[0] - m.lipL[0] > m.backR[0] - m.backL[0], 'lip wider than the back');
  // backL cannot cross backR or widen past the lip.
  const bl = clampStageDrag(m, 'backL', [0.0, 0.54222]);
  assert.ok(bl[0] > m.backR[0] - wLip);
  // back line cannot drop below the lip line.
  const blv = clampStageDrag(m, 'backL', [0.23333, 0.9]);
  assert.ok(blv[1] < (m.lipL[1] + m.lipR[1]) / 2);
  // a lip handle cannot rise above the back line or the top.
  const lv = clampStageDrag(m, 'lipL', [0.1, 0.05]);
  assert.ok(lv[1] > (m.backL[1] + m.backR[1]) / 2 && lv[1] > m.top[1]);
  // every clamped drag still validates when applied.
  for (const [key, pt] of [['backR', [0.95, 0.54]], ['top', [0.5, 0.9]], ['lipR', [0.11, 0.6]], ['backL', [0, 0.9]], ['lipL', [0.1, 0.05]], ['lipL', [0.95, 0.7]]]) {
    const marks = applyHandleDrag(m, key, clampStageDrag(m, key, pt));
    assert.deepEqual(validateMarks({ ...DIMS, marks }), { ok: true, errors: [] }, `${key} → ${pt}`);
  }
  // an in-range drag passes through unchanged.
  vnear(clampStageDrag(m, 'lipR', [0.88, 0.62]), [0.88, 0.62]);
});

test('clampStageDrag composes across drags: the three-drag sequence and 500 random runs keep validateMarks ok and the camera ahead of the lip', () => {
  const clone = (m) => JSON.parse(JSON.stringify(m));
  const step = (marks, key, pt) => applyHandleDrag(marks, key, clampStageDrag(marks, key, pt, DIMS));
  // The review's sequence: lipR up, backL down, lipL up — per-mean clamps let the lines cross.
  let m = clone(record.marks);
  m = step(m, 'lipR', [0.9, 0.543]);
  m = step(m, 'backL', [0.23333, 0.577]);
  m = step(m, 'lipL', [0.1, 0.561]);
  assert.deepEqual(validateMarks({ ...DIMS, marks: m }), { ok: true, errors: [] });
  // Fuzz: random handles to random (even off-image) points, twelve drags per run.
  let seed = 424242;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const keys = ['lipL', 'lipR', 'top', 'backL', 'backR'];
  const floor = 2 * Z_CAM_MIN;
  for (let run = 0; run < 500; run++) {
    let marks = clone(record.marks);
    for (let i = 0; i < 12; i++) {
      const key = keys[Math.floor(rnd() * keys.length)];
      marks = step(marks, key, [rnd() * 1.4 - 0.2, rnd() * 1.4 - 0.2]);
      const v = validateMarks({ ...DIMS, marks });
      assert.ok(v.ok, `run ${run} step ${i} (${key}): ${v.errors.join('; ')}`);
      const cam = solveCamera({ ...DIMS, marks }, aspect);
      assert.ok([cam.f, cam.dist_ft, cam.height_ft, cam.va_h, cam.k_y].every(Number.isFinite), `run ${run} step ${i}: non-finite camera`);
      assert.ok(cam.dist_ft >= floor - 1e-9, `run ${run} step ${i} (${key}): dist ${cam.dist_ft} below ${floor}`);
      assert.ok(worldToPixel([0, 0, 0], cam) !== null, `run ${run} step ${i}: the lip must project`);
    }
  }
  // Without dims the ratio floor still keeps the camera ahead for a 30 ft stage.
  let n = clone(record.marks);
  for (let i = 0; i < 40; i++) n = applyHandleDrag(n, 'backR', clampStageDrag(n, 'backR', [n.backL[0] + 0.0005, n.backR[1]]));
  assert.ok(solveCamera({ ...DIMS, marks: n }, aspect).dist_ft >= floor - 1e-9);
});

test('houseEdgesPx returns null when the camera cannot project the proscenium plane', () => {
  const cam = { ...solveCamera(record, aspect), dist_ft: Z_CAM_MIN / 2 };
  const house = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
  assert.equal(houseEdgesPx(cam, house), null);
});

test('guessCamera keeps all five handles inside the photo: 40×25 on 16:9, default dims on 2.4:1, 20×30×10 on 4:3', () => {
  const cases = [
    [{ width_ft: 40, height_ft: 25, depth_ft: 30 }, 0.5625],
    [DIMS, 1 / 2.4],
    [{ width_ft: 20, height_ft: 30, depth_ft: 10 }, 0.75],
  ];
  for (const [dims, asp] of cases) {
    const cam = guessCamera(dims, asp);
    const marks = marksFromCamera(cam, dims);
    for (const k of Object.keys(marks)) {
      const [u, v] = marks[k];
      assert.ok(u >= 0.05 && u <= 0.95 && v >= 0.05 && v <= 0.95, `${k} at ${u.toFixed(3)}, ${v.toFixed(3)} for ${JSON.stringify(dims)} @ ${asp}`);
    }
    assert.ok(marks.top[1] >= 0.1 - 1e-9, 'top at v ≥ 0.1');
    near(marks.lipL[1], 0.72); near(marks.lipR[1], 0.72);
    assert.ok(marks.lipR[0] - marks.lipL[0] <= 0.7 + 1e-9 && marks.lipR[0] - marks.lipL[0] >= MIN_LIP_FRACTION);
    assert.deepEqual(validateMarks({ ...dims, marks }), { ok: true, errors: [] });
  }
});

test('houseEdgesPx / housePxToFt round trip on the proscenium plane; guides lean toward the camera', () => {
  const cam = solveCamera(record, aspect);
  const house = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
  const e = houseEdgesPx(cam, house);
  near(e.left, worldToPixel([-30, 0, 0], cam)[0]); near(e.right, worldToPixel([30, 0, 0], cam)[0]);
  near(e.floor, worldToPixel([0, -3, 0], cam)[1]); near(e.ceiling, worldToPixel([0, 30, 0], cam)[1]);
  near(housePxToFt(cam, 'left', e.left), -30); near(housePxToFt(cam, 'right', e.right), 30);
  near(housePxToFt(cam, 'ceiling', e.ceiling), 30); near(housePxToFt(cam, 'floor', e.floor), -3);
  assert.equal(e.guides.length, 4);
  for (const [from, to] of e.guides) {
    assert.equal(from.length, 2); assert.equal(to.length, 2);
    assert.ok(Math.abs(to[0] - cam.u_c) > Math.abs(from[0] - cam.u_c) - 1e-9, 'guide runs outward, toward the camera');
  }
  const [[l0], [l1]] = [e.guides[0], e.guides[0]];
  assert.ok(Number.isFinite(l0[0]) && Number.isFinite(l1[0]));
});

test('clampHouse: floor never above the deck, ceiling always above the opening, walls at least a stage width apart, edits clear estimated', () => {
  const house = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
  const f = clampHouse(house, DIMS, { floor_drop_ft: -2 });
  assert.equal(f.floor_drop_ft, 0); assert.equal(f.estimated, false);
  const c = clampHouse(house, DIMS, { ceiling_ft: 15 });
  assert.ok(c.ceiling_ft > DIMS.height_ft);
  const l = clampHouse(house, DIMS, { left_wall_ft: 5 });
  assert.ok(l.left_wall_ft <= l.right_wall_ft - DIMS.width_ft);
  const r = clampHouse(house, DIMS, { right_wall_ft: -25 });
  assert.ok(r.right_wall_ft >= r.left_wall_ft + DIMS.width_ft);
  const d = clampHouse(house, DIMS, { depth_ft: -4 });
  assert.ok(d.depth_ft > 0);
  assert.deepEqual(clampHouse(house, DIMS, {}), house, 'no patch: unchanged, still estimated');
  assert.equal(house.estimated, true, 'input not mutated');
});

test('cameraFromGizmoDelta: dz adds to dist, a lift of dy lowers the camera by dy, dx shifts u_c; re-solving the produced marks reproduces the camera', () => {
  const cam = solveCamera(record, aspect);
  const { camera, marks } = cameraFromGizmoDelta(cam, DIMS, [0, 0, 10]);
  near(camera.dist_ft, cam.dist_ft + 10);
  const re = solveCamera({ ...DIMS, marks }, aspect);
  assert.ok(Math.abs(re.dist_ft - camera.dist_ft) <= camera.dist_ft * 0.005, `${re.dist_ft} vs ${camera.dist_ft}`);
  near(re.f, camera.f, 1e-6);
  const up = cameraFromGizmoDelta(cam, DIMS, [0, 2, 0]);
  near(up.camera.height_ft, cam.height_ft - 2);
  near(solveCamera({ ...DIMS, marks: up.marks }, aspect).height_ft, cam.height_ft - 2, 1e-6);
  // A lifted box rises on the photo: its lip line moves up (smaller v).
  assert.ok(up.marks.lipL[1] < record.marks.lipL[1], 'lip line moved up');
  const side = cameraFromGizmoDelta(cam, DIMS, [5, 0, 0]);
  near(side.camera.u_c, cam.u_c + 5 * cam.f / cam.dist_ft);
  near(side.marks.top[0], side.camera.u_c);
  assert.deepEqual(validateMarks({ ...DIMS, marks: side.marks }), { ok: true, errors: [] });
});

test('houseForDims: an estimated house is re-derived from the dims, an edited one is clamped to them, garbage becomes the default', () => {
  const est = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
  const wide = { width_ft: 70, height_ft: 25, depth_ft: 40 };
  assert.deepEqual(houseForDims(est, wide), defaultHouse(wide));
  const edited = { ...est, estimated: false };
  const h = houseForDims(edited, wide);
  assert.equal(h.estimated, false);
  assert.ok(h.right_wall_ft - h.left_wall_ft >= 70 - 1e-9, 'walls at least the stage width apart');
  assert.ok(h.ceiling_ft > 25, 'ceiling above the opening');
  assert.equal(h.floor_drop_ft, 3); assert.equal(h.depth_ft, 60);
  const fits = { ...edited, left_wall_ft: -40, right_wall_ft: 40, ceiling_ft: 35 };
  assert.deepEqual(houseForDims(fits, wide), fits, 'an edited house that already fits is untouched');
  assert.deepEqual(houseForDims(null, wide), defaultHouse(wide));
  assert.deepEqual(houseForDims({}, wide), defaultHouse(wide));
  assert.equal(est.estimated, true, 'input not mutated');
});

test('houseDragPatch: wall drags set X from u, floor/ceiling drags set Y from v; dropping a handle where it sits changes nothing', () => {
  const cam = solveCamera(record, aspect);
  const house = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
  const e = houseEdgesPx(cam, house);
  near(houseDragPatch(cam, 'left', [e.left, 0.5]).left_wall_ft, -30);
  near(houseDragPatch(cam, 'right', [e.right, 0.5]).right_wall_ft, 30);
  near(houseDragPatch(cam, 'floor', [0.5, e.floor]).floor_drop_ft, 3);
  near(houseDragPatch(cam, 'ceiling', [0.5, e.ceiling]).ceiling_ft, 30);
  assert.deepEqual(Object.keys(houseDragPatch(cam, 'left', [0.2, 0.5])), ['left_wall_ft'], 'one key per edge');
  assert.ok(houseDragPatch(cam, 'ceiling', [0.5, e.ceiling - 0.1]).ceiling_ft > 30, 'dragging the ceiling up raises it');
  assert.ok(houseDragPatch(cam, 'floor', [0.5, e.floor + 0.1]).floor_drop_ft > 3, 'dragging the floor down deepens the drop');
  assert.throws(() => houseDragPatch(cam, 'roof', [0.5, 0.5]));
});

test('houseWidthPatch keeps the walls centred and sets their distance', () => {
  const p = houseWidthPatch({ left_wall_ft: -20, right_wall_ft: 40 }, 30);
  near(p.left_wall_ft, -5); near(p.right_wall_ft, 25);
  assert.deepEqual(Object.keys(p).sort(), ['left_wall_ft', 'right_wall_ft']);
});

test('cameraDelta inverts cameraFromGizmoDelta: the world delta between two cameras (dx via u_c, dy height, dz distance)', () => {
  const cam = solveCamera(record, aspect);
  const { camera: moved } = cameraFromGizmoDelta(cam, DIMS, [1.5, -2, 10]);
  vnear(cameraDelta(cam, moved), [1.5, -2, 10], 1e-9);
  vnear(cameraDelta(cam, cam), [0, 0, 0]);
  // Re-solving the moved camera's marks reproduces the delta closely (Task 1's 0.5 % round trip).
  const { marks } = cameraFromGizmoDelta(cam, DIMS, [0, 0, 10]);
  const resolved = solveCamera({ ...record, marks }, aspect);
  const d = cameraDelta(cam, resolved);
  near(d[2], 10, 0.05); near(d[0], 0, 0.05); near(d[1], 0, 0.05);
});
