import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HEIGHT_REFS, toDeck, fromDeck, recomputePositionsForHouse, recomputeBoomFixturesForHouse, describeHeight,
  positionWithHeightRef, positionWithHeightInput, fixtureWithHeightInput,
} from '../../../src/rig/height-ref.js';
import { defaultHouse } from '../../../src/rig/geometry.js';

const HOUSE = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: false };
const near = (a, b, t = 1e-9) => assert.ok(Math.abs(a - b) <= t, `${a} !~ ${b}`);

test('HEIGHT_REFS and the deck conversions', () => {
  assert.deepEqual(HEIGHT_REFS, ['deck', 'house_floor', 'ceiling']);
  assert.equal(toDeck(12, 'house_floor', { floor_drop_ft: 3 }), 9);
  assert.equal(toDeck(4, 'ceiling', { ceiling_ft: 30 }), 26);
  assert.equal(toDeck(7, 'deck', HOUSE), 7);
  assert.equal(fromDeck(9, 'house_floor', { floor_drop_ft: 3 }), 12);
  assert.equal(fromDeck(26, 'ceiling', { ceiling_ft: 30 }), 4);
  assert.equal(fromDeck(7, 'deck', HOUSE), 7);
  for (const ref of HEIGHT_REFS) near(fromDeck(toDeck(11.5, ref, HOUSE), ref, HOUSE), 11.5);
});

test('recomputePositionsForHouse re-derives non-deck pipe trims from height_input_ft; deck pipes and booms untouched', () => {
  const positions = [
    { id: 'a', name: 'A', kind: 'pipe', upstage_ft: 6, trim_ft: 20 },                                          // deck (implicit)
    { id: 'b', name: 'B', kind: 'pipe', upstage_ft: 14, trim_ft: 26, height_ref: 'ceiling', height_input_ft: 4 },
    { id: 'c', name: 'C', kind: 'pipe', upstage_ft: 22, trim_ft: 9, height_ref: 'house_floor', height_input_ft: 12 },
    { id: 'd', name: 'D', kind: 'boom', upstage_ft: 8, offset_ft: -22, height_ref: 'ceiling', height_input_ft: 2 },
    { id: 'e', name: 'E', kind: 'pipe', upstage_ft: 30, trim_ft: 18, height_ref: 'deck', height_input_ft: 18 },
  ];
  const higher = { ...HOUSE, ceiling_ft: 36, floor_drop_ft: 5 };
  const out = recomputePositionsForHouse(positions, higher);
  assert.notEqual(out, positions);
  assert.equal(out[0].trim_ft, 20, 'deck pipe unchanged');
  assert.equal(out[4].trim_ft, 18, 'explicit deck pipe unchanged');
  assert.equal(out[1].trim_ft, 32, '4 ft below a 36 ft ceiling');
  assert.equal(out[2].trim_ft, 7, '12 ft above a house floor 5 ft down');
  assert.equal(out[3].offset_ft, -22, 'a boom keeps its X offset (fixture heights live on the lights)');
  assert.equal(positions[1].trim_ft, 26, 'input not mutated');
  assert.equal(out[1].height_input_ft, 4, 'the stated number is kept');
});

test('describeHeight formats both readings in feet and meters', () => {
  assert.equal(describeHeight(9, HOUSE, 'ft'), '12.0 ft above house floor · 21.0 ft below ceiling');
  assert.equal(describeHeight(26, HOUSE, 'ft'), '29.0 ft above house floor · 4.0 ft below ceiling');
  assert.equal(describeHeight(9, HOUSE, 'm'), '3.7 m above house floor · 6.4 m below ceiling');
});

test('defaultHouse follows the venue dimensions and is marked estimated', () => {
  assert.deepEqual(defaultHouse({ width_ft: 40, height_ft: 20, depth_ft: 30 }), {
    left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true,
  });
  assert.deepEqual(defaultHouse({ width_ft: 24, height_ft: 14, depth_ft: 18 }), {
    left_wall_ft: -18, right_wall_ft: 18, floor_drop_ft: 3, ceiling_ft: 24, depth_ft: 36, estimated: true,
  });
});

test('recomputeBoomFixturesForHouse re-derives boom fixture heights stated against the house; others untouched', () => {
  const positions = [
    { id: 'bsl', name: 'BSL', kind: 'boom', upstage_ft: 8, offset_ft: 22, height_ref: 'ceiling' },
    { id: 'bsr', name: 'BSR', kind: 'boom', upstage_ft: 8, offset_ft: -22 },                       // deck
    { id: '1e', name: '1E', kind: 'pipe', upstage_ft: 6, trim_ft: 20, height_ref: 'ceiling', height_input_ft: 10 },
  ];
  const lights = [
    { id: 'a', fixture: { type: 'ers', position_id: 'bsl', offset_ft: 26, area: null, height_input_ft: 4 } },   // 4 ft below a 30 ft ceiling
    { id: 'b', fixture: { type: 'ers', position_id: 'bsl', offset_ft: 12, area: null } },                        // no stated height: untouched
    { id: 'c', fixture: { type: 'ers', position_id: 'bsr', offset_ft: 9, area: null, height_input_ft: 9 } },     // deck boom: untouched
    { id: 'd', fixture: { type: 'ers', position_id: '1e', offset_ft: 3, area: null, height_input_ft: 3 } },      // pipe: X offset, untouched
    { id: 'r', type: 'reflector' },
  ];
  const n = recomputeBoomFixturesForHouse(lights, positions, { ...HOUSE, ceiling_ft: 36 });
  assert.equal(n, 1, 'one fixture re-derived');
  assert.equal(lights[0].fixture.offset_ft, 32);
  assert.equal(lights[0].fixture.height_input_ft, 4, 'the stated number is kept');
  assert.equal(lights[1].fixture.offset_ft, 12);
  assert.equal(lights[2].fixture.offset_ft, 9);
  assert.equal(lights[3].fixture.offset_ft, 3);
});

test('positionWithHeightRef converts the shown number so the physical height does not move; positionWithHeightInput re-derives the trim', () => {
  const pipe = { id: 'p', name: 'P', kind: 'pipe', upstage_ft: 6, trim_ft: 26 };
  const c = positionWithHeightRef(pipe, 'ceiling', HOUSE);
  assert.deepEqual(c, { ...pipe, height_ref: 'ceiling', height_input_ft: 4 });
  assert.equal(pipe.height_ref, undefined, 'input not mutated');
  const f = positionWithHeightRef(c, 'house_floor', HOUSE);
  assert.equal(f.trim_ft, 26); assert.equal(f.height_input_ft, 29);
  const d = positionWithHeightRef(f, 'deck', HOUSE);
  assert.equal(d.trim_ft, 26); assert.equal(d.height_input_ft, 26);
  const typed = positionWithHeightInput(c, 6, HOUSE);
  assert.equal(typed.height_input_ft, 6); assert.equal(typed.trim_ft, 24, '6 ft below a 30 ft ceiling');
  const typedDeck = positionWithHeightInput(pipe, 18, HOUSE);
  assert.equal(typedDeck.trim_ft, 18); assert.equal(typedDeck.height_input_ft, 18);
  const boom = { id: 'b', name: 'B', kind: 'boom', upstage_ft: 8, offset_ft: 22 };
  const bc = positionWithHeightRef(boom, 'ceiling', HOUSE);
  assert.equal(bc.height_ref, 'ceiling'); assert.equal(bc.offset_ft, 22, 'a boom keeps its X offset');
  assert.equal('height_input_ft' in bc, false);
});

test('fixtureWithHeightInput sets a boom fixture height in the position reference', () => {
  const boom = { id: 'b', name: 'B', kind: 'boom', upstage_ft: 8, offset_ft: 22, height_ref: 'ceiling' };
  const L = { id: 'a', fixture: { type: 'ers', position_id: 'b', offset_ft: 12, area: null } };
  fixtureWithHeightInput(L, 4, boom, HOUSE);
  assert.equal(L.fixture.offset_ft, 26); assert.equal(L.fixture.height_input_ft, 4);
  const deckBoom = { ...boom, height_ref: 'deck' };
  fixtureWithHeightInput(L, 9, deckBoom, HOUSE);
  assert.equal(L.fixture.offset_ft, 9); assert.equal('height_input_ft' in L.fixture, false, 'deck: no stated number kept');
});
