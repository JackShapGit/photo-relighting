import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, venueFromForm } from '../../../src/rig/venue-editor.js';
import { SYNTHETIC_VENUE, defaultHouse } from '../../../src/rig/geometry.js';

const V = SYNTHETIC_VENUE;
const near = (a, b, t = 1e-6) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);

test('badgeText reads "<name> · W × H × D <unit>" with trailing .0 trimmed', () => {
  assert.equal(badgeText(V, 'ft'), 'Test House · 40 × 20 × 30 ft');
  assert.equal(badgeText({ ...V, width_ft: 40.5 }, 'ft'), 'Test House · 40.5 × 20 × 30 ft');
  assert.equal(badgeText(V, 'm'), 'Test House · 12.2 × 6.1 × 9.1 m');
  assert.equal(badgeText(V), 'Test House · 40 × 20 × 30 ft', 'feet by default');
});

const form = (over = {}) => ({
  name: 'Capri', width: '40', height: '20', depth: '30', rows: '3', cols: '3', focus: '5',
  number_from_stage_left: false, positions: V.positions, ...over,
});
const HOUSE = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
const houseForm = (over = {}) => ({ left: '-30', right: '30', floor_drop: '3', ceiling: '30', depth: '60', ...over });

test('venueFromForm parses feet, keeps the id/positions, and reports no errors', () => {
  const { venue, errors } = venueFromForm(form(), 'ft', V);
  assert.deepEqual(errors, []);
  assert.equal(venue.id, V.id);
  assert.equal(venue.name, 'Capri');
  assert.equal(venue.width_ft, 40); assert.equal(venue.height_ft, 20); assert.equal(venue.depth_ft, 30);
  assert.deepEqual(venue.grid, { rows: 3, cols: 3, number_from_stage_left: false });
  assert.equal(venue.focus_height_ft, 5);
  assert.equal(venue.positions, V.positions);
});

test('venueFromForm converts meters and accepts feet-inches / unit suffixes', () => {
  const { venue, errors } = venueFromForm(form({ width: '12.2', height: '6', depth: '9', focus: '1.5' }), 'm', V);
  assert.deepEqual(errors, []);
  near(venue.width_ft, 12.2 / 0.3048); near(venue.height_ft, 6 / 0.3048); near(venue.depth_ft, 9 / 0.3048);
  near(venue.focus_height_ft, 1.5 / 0.3048);
  const mixed = venueFromForm(form({ width: "40'6\"", height: '6 m', depth: '30 ft' }), 'ft', V).venue;
  near(mixed.width_ft, 40.5); near(mixed.height_ft, 6 / 0.3048); near(mixed.depth_ft, 30);
});

test('venueFromForm clamps the grid to 1–6 and rounds it', () => {
  assert.deepEqual(venueFromForm(form({ rows: '0', cols: '9' }), 'ft', V).venue.grid, { rows: 1, cols: 6, number_from_stage_left: false });
  assert.deepEqual(venueFromForm(form({ rows: '2.7', cols: 'abc' }), 'ft', V).venue.grid, { rows: 3, cols: 3, number_from_stage_left: false });
  assert.equal(venueFromForm(form({ number_from_stage_left: true }), 'ft', V).venue.grid.number_from_stage_left, true);
});

test('venueFromForm reports errors for a blank name, non-positive or garbage dimensions, negative focus', () => {
  const e1 = venueFromForm(form({ name: '  ' }), 'ft', V).errors;
  assert.ok(e1.some((m) => /name/i.test(m)));
  const e2 = venueFromForm(form({ width: '0', height: '-3', depth: 'wide' }), 'ft', V).errors;
  assert.ok(e2.some((m) => /width/i.test(m)) && e2.some((m) => /height/i.test(m)) && e2.some((m) => /depth/i.test(m)));
  const e3 = venueFromForm(form({ focus: '-1' }), 'ft', V).errors;
  assert.ok(e3.some((m) => /focus/i.test(m)));
  assert.equal(venueFromForm(form({ focus: '0' }), 'ft', V).errors.length, 0, 'a zero focus height is allowed');
});

test('venueFromForm: untouched house fields keep the base house (still estimated); default_height_ref passes through', () => {
  const { venue, errors } = venueFromForm(form({ house: houseForm(), house_edited: false, default_height_ref: 'ceiling' }), 'ft', { ...V, house: HOUSE });
  assert.deepEqual(errors, []);
  assert.deepEqual(venue.house, HOUSE);
  assert.equal(venue.default_height_ref, 'ceiling');
  assert.equal(venueFromForm(form(), 'ft', V).venue.default_height_ref, 'deck', 'default when absent');
  assert.equal(venueFromForm(form(), 'ft', V).venue.house, undefined, 'no house on the base and none typed: none written');
});

test('venueFromForm parses edited house fields in the current unit; valid edits clear estimated without messages', () => {
  const { venue, errors } = venueFromForm(form({ house: houseForm({ ceiling: '34', left: '-28' }), house_edited: true }), 'ft', { ...V, house: HOUSE });
  assert.deepEqual(errors, []);
  assert.equal(venue.house.ceiling_ft, 34);
  assert.equal(venue.house.left_wall_ft, -28);
  assert.equal(venue.house.estimated, false);
  const m = venueFromForm(form({ width: '12.2', height: '6.1', depth: '9.1', house: houseForm({ left: '-9', right: '9', floor_drop: '1', ceiling: '9', depth: '18' }), house_edited: true }), 'm', { ...V, house: HOUSE }).venue.house;
  near(m.left_wall_ft, -9 / 0.3048); near(m.ceiling_ft, 9 / 0.3048); near(m.depth_ft, 18 / 0.3048);
  const bad = venueFromForm(form({ house: houseForm({ ceiling: 'high' }), house_edited: true }), 'ft', { ...V, house: HOUSE }).errors;
  assert.ok(bad.some((e) => /ceiling/i.test(e)));
});

test('venueFromForm: a house value the clamp would alter is reported with its rule (and the value clamped)', () => {
  const run = (over) => venueFromForm(form({ house: houseForm(over), house_edited: true }), 'ft', { ...V, house: HOUSE });
  const floor = run({ floor_drop: '-2' });
  assert.ok(floor.errors.some((e) => /floor drop/i.test(e) && /deck/i.test(e)), floor.errors.join(' | '));
  assert.equal(floor.venue.house.floor_drop_ft, 0);
  const ceiling = run({ ceiling: '15' });
  assert.ok(ceiling.errors.some((e) => /ceiling/i.test(e) && /20\.5 ft/.test(e)), ceiling.errors.join(' | '));
  assert.ok(ceiling.venue.house.ceiling_ft >= 20.5);
  const walls = run({ left: '5' });                       // right stays 30: 25 ft apart on a 40 ft stage
  assert.ok(walls.errors.some((e) => /walls/i.test(e) && /40\.0 ft/.test(e)), walls.errors.join(' | '));
  assert.equal(walls.errors.filter((e) => /walls/i.test(e)).length, 1, 'one message for the pair');
  const depth = run({ depth: '0' });
  assert.ok(depth.errors.some((e) => /depth/i.test(e) && /1\.0 ft/.test(e)), depth.errors.join(' | '));
  assert.deepEqual(run({ ceiling: '25', floor_drop: '0', depth: '1', left: '-10', right: '30' }).errors, [], 'edge values pass');
  const m = venueFromForm(form({ width: '12.2', height: '6.1', depth: '9.1', house: houseForm({ ceiling: '5', left: '-9', right: '9', floor_drop: '1', depth: '18' }), house_edited: true }), 'm', { ...V, house: HOUSE });
  assert.ok(m.errors.some((e) => /ceiling/i.test(e) && e.includes(' m)')), 'rule stated in the form unit: ' + m.errors.join(' | '));
});

test('venueFromForm: a dims-only edit re-derives an estimated house silently and reports the rule for an edited house that no longer fits', () => {
  const est = venueFromForm(form({ width: '60' }), 'ft', { ...V, house: HOUSE });
  assert.deepEqual(est.errors, []);
  assert.deepEqual(est.venue.house, defaultHouse({ width_ft: 60, height_ft: 20, depth_ft: 30 }));
  const edited = venueFromForm(form({ width: '70' }), 'ft', { ...V, house: { ...HOUSE, estimated: false } });
  assert.ok(edited.errors.some((e) => /walls/i.test(e) && e.includes('70.0 ft')), edited.errors.join(' | '));
  const tall = venueFromForm(form({ height: '30' }), 'ft', { ...V, house: { ...HOUSE, estimated: false } });
  assert.ok(tall.errors.some((e) => /ceiling/i.test(e) && e.includes('30.5 ft')), tall.errors.join(' | '));
  const fits = venueFromForm(form({ width: '50' }), 'ft', { ...V, house: { ...HOUSE, estimated: false } });
  assert.deepEqual(fits.errors, []);
  assert.deepEqual(fits.venue.house, { ...HOUSE, estimated: false });
});
