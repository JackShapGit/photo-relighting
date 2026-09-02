import { test } from 'node:test';
import assert from 'node:assert/strict';
import { badgeText, venueFromForm } from '../../../src/rig/venue-editor.js';
import { SYNTHETIC_VENUE } from '../../../src/rig/geometry.js';

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
