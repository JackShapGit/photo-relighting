import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  rowsForVenue, nextOffset, positionLabels, positionFields, changeKind, newPosition,
  buildFixtureLight, cloneFixture, optionControl, validPositionValue, validOffset,
  setFixtureType, setFixtureOption, setFixturePosition, setFixtureArea, setFixtureOffset,
  CUSTOM_ROW_ID, heightRefHint,
} from '../../../src/rig/rig-tab.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';
import { solveRecord } from '../../../src/metric/light-metric.js';
import { SYNTHETIC_STAGE } from '../../../src/metric/calibration.js';

const V = SYNTHETIC_VENUE;
const record = solveRecord({ ...SYNTHETIC_STAGE.record, depth_fit: { a: -0.037037, b: 0.024074 } }, SYNTHETIC_STAGE.aspect);
const pos = (name) => V.positions.find((p) => p.name === name);
const light = (id, position_id, offset_ft = 0, extra = {}) => ({
  kind: 'light', id, name: id, type: 'spotlight', enabled: true, position: [0.5, 0.5, 0.5], direction: [0, 0, 1],
  intensity: 1, falloff: 1, cone_angle: 0.3, softness: 0.1, gobo: null,
  fixture: { type: 'ers', position_id, offset_ft, area: null, barrel_deg: 26 }, ...extra,
});

// ── rowsForVenue ─────────────────────────────────────────────────────────
test('rowsForVenue groups fixtures in venue order, Custom last, reflectors excluded', () => {
  const a = light('a', 'p_1e'), b = light('b', 'p_foh'), c = light('c', null), d = light('d', 'p_gone');
  const plain = { kind: 'light', id: 'e', name: 'e', type: 'point', enabled: true };
  const r = { kind: 'light', id: 'r', name: 'r', type: 'reflector', enabled: true };
  const rows = rowsForVenue([a, b, c, d, plain, r], V);
  assert.deepEqual(rows.map((g) => g.id), ['pos:p_foh', 'pos:p_1e', 'pos:p_2e', 'pos:p_3e', 'pos:p_bsr', 'pos:p_bsl', CUSTOM_ROW_ID]);
  assert.deepEqual(rows.map((g) => g.name), ['FOH', '1E', '2E', '3E', 'BSR', 'BSL', 'Custom']);
  assert.equal(rows[0].position, pos('FOH'));
  assert.equal(rows[6].position, null);
  assert.deepEqual(rows[0].fixtures, [b]);
  assert.deepEqual(rows[1].fixtures, [a]);
  assert.deepEqual(rows[6].fixtures, [c, d, plain], 'custom, unknown position, and fixture-less emitters are Custom');
  assert.ok(rows.every((g) => !g.fixtures.includes(r)));
  assert.ok(rows.slice(2, 6).every((g) => g.fixtures.length === 0), 'empty positions still listed');
});

// ── nextOffset ───────────────────────────────────────────────────────────
test('nextOffset is the last fixture on that position plus 2 ft, else 0', () => {
  const lights = [light('a', 'p_1e', -6), light('b', 'p_2e', 9), light('c', 'p_1e', 4), light('d', null, 40)];
  assert.equal(nextOffset(lights, 'p_1e'), 6);
  assert.equal(nextOffset(lights, 'p_2e'), 11);
  assert.equal(nextOffset(lights, 'p_3e'), 0);
  assert.equal(nextOffset([], 'p_1e'), 0);
  assert.equal(nextOffset(lights, null), 0, 'Custom has no offsets');
});

// ── positionLabels / positionFields ──────────────────────────────────────
test('positionLabels follow the kind and the display unit', () => {
  assert.deepEqual(positionLabels('pipe', 'ft'), { n1: 'Upstage (ft)', n2: 'Trim (ft)' });
  assert.deepEqual(positionLabels('boom', 'ft'), { n1: 'Offset (ft)', n2: 'Upstage (ft)' });
  assert.deepEqual(positionLabels('floor', 'ft'), { n1: 'Upstage (ft)', n2: '—' });
  assert.deepEqual(positionLabels('pipe', 'm'), { n1: 'Upstage (m)', n2: 'Trim (m)' });
  assert.deepEqual(positionLabels('boom', 'm'), { n1: 'Offset (m)', n2: 'Upstage (m)' });
  assert.deepEqual(positionLabels('floor', 'm'), { n1: 'Upstage (m)', n2: '—' });
});

test('positionFields name the venue fields behind the two number columns', () => {
  assert.deepEqual(positionFields('pipe'), { n1: 'upstage_ft', n2: 'trim_ft' });
  assert.deepEqual(positionFields('boom'), { n1: 'offset_ft', n2: 'upstage_ft' });
  assert.deepEqual(positionFields('floor'), { n1: 'upstage_ft', n2: null });
});

// ── changeKind / newPosition ─────────────────────────────────────────────
test('changeKind drops the field that no longer applies and fills the one now required', () => {
  const pipe = { id: 'p', name: 'P', kind: 'pipe', upstage_ft: 6, trim_ft: 20 };
  const boom = changeKind(pipe, 'boom', V);
  assert.deepEqual(boom, { id: 'p', name: 'P', kind: 'boom', upstage_ft: 6, offset_ft: 0 });
  assert.notEqual(boom, pipe, 'a new object');
  const back = changeKind(boom, 'pipe', V);
  assert.deepEqual(back, { id: 'p', name: 'P', kind: 'pipe', upstage_ft: 6, trim_ft: V.height_ft });
  const floor = changeKind(back, 'floor', V);
  assert.deepEqual(floor, { id: 'p', name: 'P', kind: 'floor', upstage_ft: 6 });
  assert.equal(changeKind(pipe, 'pipe', V), pipe, 'same kind: untouched');
});

test('newPosition is a pipe 8 ft upstage of the last one at the venue height, named Pipe N', () => {
  const p = newPosition(V);
  assert.equal(p.kind, 'pipe');
  assert.equal(p.upstage_ft, 8 + 8);   // BSL (last) is at 8
  assert.equal(p.trim_ft, V.height_ft);
  assert.equal(p.name, 'Pipe 7');
  assert.ok(typeof p.id === 'string' && p.id.length > 3 && !V.positions.some((q) => q.id === p.id));
  const first = newPosition({ ...V, positions: [] });
  assert.equal(first.upstage_ft, 0);
  assert.equal(first.name, 'Pipe 1');
  assert.notEqual(newPosition(V).id, newPosition(V).id, 'fresh ids');
});

test('newPosition states its height in the venue default reference (height_input_ft from the deck trim)', () => {
  const house = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: false };
  const ceiling = newPosition({ ...V, house, default_height_ref: 'ceiling' });
  assert.equal(ceiling.height_ref, 'ceiling');
  assert.equal(ceiling.trim_ft, 20, 'stored trim stays deck-relative');
  assert.equal(ceiling.height_input_ft, 10, '30 ft ceiling − 20 ft trim');
  const floor = newPosition({ ...V, house, default_height_ref: 'house_floor' });
  assert.equal(floor.height_ref, 'house_floor');
  assert.equal(floor.height_input_ft, 23);
  const deck = newPosition({ ...V, house, default_height_ref: 'deck' });
  assert.equal(deck.height_ref, 'deck');
  assert.equal(deck.height_input_ft, undefined, 'a deck height carries no stated number');
  assert.equal(newPosition(V).height_ref, 'deck', 'no default on the venue: deck');
  const noHouse = newPosition({ ...V, default_height_ref: 'ceiling' });
  assert.equal(noHouse.height_ref, 'ceiling');
  assert.equal(noHouse.height_input_ft, 10, 'the estimated house (ceiling = height + 10) is used when the venue has none');
});

test('heightRefHint names the reference a boom fixture height is stated in', () => {
  assert.equal(heightRefHint('deck'), 'above deck');
  assert.equal(heightRefHint('house_floor'), 'above house floor');
  assert.equal(heightRefHint('ceiling'), 'below ceiling');
  assert.equal(heightRefHint(undefined), 'above deck');
});

// ── buildFixtureLight / cloneFixture ─────────────────────────────────────
test('buildFixtureLight makes a preset-applied fixture on a position (or Custom)', () => {
  const L = buildFixtureLight(V, pos('1E'), 'ers', 4, 3);
  assert.equal(L.kind, 'light');
  assert.equal(L.name, '1E-3');
  assert.equal(L.type, 'spotlight');
  assert.deepEqual(L.fixture, { type: 'ers', position_id: 'p_1e', offset_ft: 4, area: null, barrel_deg: 26 });
  assert.ok(Math.abs(L.cone_angle - (13 * Math.PI / 180)) < 1e-9, '26° field → 13° half-angle');
  assert.equal(L.color_temperature, 3200);
  assert.equal(L.enabled, true);
  const C = buildFixtureLight(V, null, 'fresnel', 0, 2);
  assert.equal(C.name, 'Custom-2');
  assert.equal(C.fixture.position_id, null);
  assert.equal(C.fixture.beam_deg, 30);
  const cyc = buildFixtureLight(V, pos('3E'), 'cyc', 0, 1);
  assert.equal(cyc.type, 'linear');
  assert.equal(cyc.fixture.length_ft, 4);
  assert.notEqual(buildFixtureLight(V, null, 'ers', 0, 1).id, buildFixtureLight(V, null, 'ers', 0, 1).id);
});

test('buildFixtureLight aims a hung fixture at stage centre; Custom keeps the generic default', () => {
  // Ruling T4-B: newLightNode's fill default (lights.js) is Y-flat, so an
  // unaimed hung fixture would never cross the focus plane. A fixture hung
  // on a position gets a direction_ft pointing at [0, focus_height_ft,
  // depth_ft/2] instead. For FOH (upstage_ft -52, trim_ft 22) at offset 4,
  // against V's focus_height_ft 5 and depth_ft 30: from [4, 22, -52] to
  // [0, 5, 15] is [-4, -17, 67], normalized — computed independently, not
  // copied from the implementation, so a wrong-but-plausible target (still
  // downward, still upstage) would fail this.
  const L = buildFixtureLight(V, pos('FOH'), 'ers', 4, 1);
  assert.ok(Array.isArray(L.direction_ft));
  const [x, y, z] = L.direction_ft;
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  assert.ok(near(x, -0.05777114517518152), `x ${x}`);
  assert.ok(near(y, -0.24552736699452146), `y ${y}`);
  assert.ok(near(z, 0.9676666816842904), `z ${z}`);
  assert.ok(near(Math.hypot(x, y, z), 1), 'normalized');

  const C = buildFixtureLight(V, null, 'ers', 0, 1);
  assert.equal(C.direction_ft, undefined, 'Custom has no position to aim from; keeps the generic default');
});

test('cloneFixture copies the light with a new id, the next name, and offset + 2', () => {
  const L = buildFixtureLight(V, pos('1E'), 'ers', 4, 1);
  L.gobo = { texture_id: 'breakup' }; L.position_ft = [4, 20, 6];
  const C = cloneFixture(L, [L], V);
  assert.notEqual(C.id, L.id);
  assert.equal(C.name, '1E-2');
  assert.equal(C.fixture.offset_ft, 6);
  assert.deepEqual(C.gobo, { texture_id: 'breakup' });
  assert.notEqual(C.fixture, L.fixture, 'deep copy');
  assert.notEqual(C.position_ft, L.position_ft);
  const K = light('k', null); K.name = 'Special';
  assert.equal(cloneFixture(K, [K], V).name, 'Special Copy');
});

// ── option column ────────────────────────────────────────────────────────
test('optionControl describes the type-specific column', () => {
  assert.deepEqual(optionControl('ers'), { key: 'barrel_deg', kind: 'select', values: [19, 26, 36, 50], label: 'Barrel' });
  assert.deepEqual(optionControl('par'), { key: 'lamp', kind: 'select', values: ['VNSP', 'NSP', 'MFL', 'WFL'], label: 'Lamp' });
  assert.deepEqual(optionControl('fresnel'), { key: 'beam_deg', kind: 'number', min: 10, max: 60, step: 1, label: 'Beam °' });
  assert.deepEqual(optionControl('moving_head'), { key: 'beam_deg', kind: 'number', min: 10, max: 50, step: 1, label: 'Beam °' });
  assert.deepEqual(optionControl('other'), { key: 'beam_deg', kind: 'number', min: 5, max: 90, step: 1, label: 'Beam °' });
  assert.deepEqual(optionControl('cyc'), { key: 'length_ft', kind: 'length', label: 'Length' });
  assert.deepEqual(optionControl('followspot'), { key: null, kind: 'none', label: '' });
});

// ── validation ───────────────────────────────────────────────────────────
test('validPositionValue / validOffset reject NaN, negative trim, and offsets beyond ±3× the width', () => {
  assert.equal(validPositionValue('trim_ft', 20, V), true);
  assert.equal(validPositionValue('trim_ft', -1, V), false);
  assert.equal(validPositionValue('trim_ft', NaN, V), false);
  assert.equal(validPositionValue('upstage_ft', -52, V), true);
  assert.equal(validPositionValue('offset_ft', 120, V), true);
  assert.equal(validPositionValue('offset_ft', 121, V), false);
  assert.equal(validPositionValue('offset_ft', -121, V), false);
  assert.equal(validOffset(pos('1E'), 119, V), true);
  assert.equal(validOffset(pos('1E'), 130, V), false);
  assert.equal(validOffset(pos('BSL'), -1, V), false, 'boom height below the deck');
  assert.equal(validOffset(pos('BSL'), 61, V), false, 'boom height above 3× the opening');
  assert.equal(validOffset(pos('BSL'), 12, V), true);
});

// ── shared per-field updates ─────────────────────────────────────────────
test('setFixtureType re-applies the preset, keeps position/offset/area/name, and reports a removed gobo', () => {
  const L = buildFixtureLight(V, pos('1E'), 'ers', 4, 1);
  L.fixture.area = '5'; L.intensity = 0.7; L.gobo = { texture_id: 'breakup' };
  const res = setFixtureType(L, 'fresnel', V, record);
  assert.equal(L.type, 'spotlight');
  assert.equal(L.fixture.type, 'fresnel');
  assert.equal(L.fixture.beam_deg, 30);
  assert.equal(L.fixture.position_id, 'p_1e'); assert.equal(L.fixture.offset_ft, 4); assert.equal(L.fixture.area, '5');
  assert.equal(L.name, '1E-1'); assert.equal(L.intensity, 0.7);
  assert.equal(L.gobo, null); assert.equal(res.goboRemoved, true);
  assert.deepEqual(L.position_ft, [4, 20, 6]); assert.deepEqual(L.target_ft, [0, 5, 15]);
  assert.equal(setFixtureType(L, 'ers', V, record).goboRemoved, false);
  assert.equal(L.fixture.barrel_deg, 26, 'default option for the new type');
  setFixtureType(L, 'cyc', V, record);
  assert.equal(L.type, 'linear');
  assert.deepEqual(L.endpoint_a_ft, [2, 20, 6]); assert.deepEqual(L.endpoint_b_ft, [6, 20, 6]);
  setFixtureType(L, 'par', V, record);
  assert.equal(L.type, 'spotlight'); assert.equal('endpoint_a_ft' in L, false);
});

test('setFixtureOption, setFixtureOffset, setFixtureArea, setFixturePosition re-derive the light', () => {
  const L = buildFixtureLight(V, pos('1E'), 'ers', 4, 1);
  setFixtureOption(L, 50, V, record);
  assert.equal(L.fixture.barrel_deg, 50);
  assert.ok(Math.abs(L.cone_angle - (25 * Math.PI / 180)) < 1e-9);
  setFixtureOffset(L, -3, V, record);
  assert.deepEqual(L.position_ft, [-3, 20, 6]);
  setFixtureArea(L, '5', V, record);
  assert.deepEqual(L.target_ft, [0, 5, 15]);
  setFixtureArea(L, null, V, record);
  assert.equal(L.fixture.area, null);
  assert.deepEqual(L.target_ft, [0, 5, 15], 'existing aim kept');
  setFixturePosition(L, 'p_bsl', V, record);      // snaps to the nearest offset: Y = 20 on the boom
  assert.equal(L.fixture.position_id, 'p_bsl');
  assert.equal(L.fixture.offset_ft, 20);
  assert.deepEqual(L.position_ft, [22, 20, 8]);
  setFixturePosition(L, null, V, record);
  assert.equal(L.fixture.position_id, null);
  assert.deepEqual(L.position_ft, [22, 20, 8], 'Custom keeps its spot');
  const cyc = buildFixtureLight(V, pos('3E'), 'cyc', 0, 1);
  setFixtureOption(cyc, 8, V, record);
  assert.deepEqual(cyc.endpoint_a_ft, [-4, 20, 22]); assert.deepEqual(cyc.endpoint_b_ft, [4, 20, 22]);
});
