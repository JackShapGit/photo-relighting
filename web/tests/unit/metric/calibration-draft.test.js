import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDraftState, reduce, serializeUndo, hydrateUndo, HISTORY_CAP } from '../../../src/metric/calibration-draft.js';
import { SYNTHETIC_STAGE } from '../../../src/metric/calibration.js';

const { record } = SYNTHETIC_STAGE;
const DIMS = { width_ft: 40, height_ft: 20, depth_ft: 30 };
const HOUSE = { left_wall_ft: -30, right_wall_ft: 30, floor_drop_ft: 3, ceiling_ft: 30, depth_ft: 60, estimated: true };
const applied0 = { marks: record.marks, dims: DIMS, house: HOUSE };
const snap = (n, extra = {}) => ({
  calibration: { ...record, marks: { ...record.marks, top: [0.5, 0.08 + n / 100] } },
  venue: { dims: { ...DIMS, width_ft: 40 + n }, house: HOUSE },
  fixtures: [{ id: `L${n}`, position_ft: [n, 20, 6], target_ft: [0, 5, 15], endpoint_a_ft: null, endpoint_b_ft: null }],
  ...extra,
});

test('createDraftState: draft mirrors applied, nothing dirty, empty history', () => {
  const S = createDraftState(applied0);
  assert.deepEqual(S.applied, applied0);
  assert.deepEqual(S.draft, applied0);
  assert.notEqual(S.draft, S.applied, 'draft is a copy');
  assert.deepEqual(S.history, []); assert.equal(S.redo, null); assert.equal(S.dirty, false);
  const empty = createDraftState(null);
  assert.equal(empty.applied, null); assert.equal(empty.draft, null);
});

test('edit changes only the draft and sets dirty; revert restores draft = applied and clears dirty', () => {
  const S0 = createDraftState(applied0);
  const S1 = reduce(S0, { type: 'edit', patch: { marks: { top: [0.5, 0.2] } } });
  assert.deepEqual(S1.draft.marks.top, [0.5, 0.2]);
  assert.deepEqual(S1.draft.marks.lipL, record.marks.lipL, 'other marks kept');
  assert.deepEqual(S1.applied, applied0, 'applied untouched');
  assert.equal(S1.dirty, true);
  assert.deepEqual(S0.draft.marks.top, [0.5, 0.08], 'input state not mutated');
  const S2 = reduce(S1, { type: 'edit', patch: { dims: { width_ft: 44 }, house: { ceiling_ft: 33 } } });
  assert.equal(S2.draft.dims.width_ft, 44); assert.equal(S2.draft.dims.depth_ft, 30);
  assert.equal(S2.draft.house.ceiling_ft, 33); assert.equal(S2.draft.house.floor_drop_ft, 3);
  const S3 = reduce(S2, { type: 'revert' });
  assert.deepEqual(S3.draft, applied0); assert.equal(S3.dirty, false);
  assert.deepEqual(S3.history, []);
});

test('apply makes the draft applied, pushes the caller snapshot, clears dirty and redo', () => {
  const S1 = reduce(createDraftState(applied0), { type: 'edit', patch: { marks: { top: [0.5, 0.2] } } });
  const S2 = reduce(S1, { type: 'apply', snapshot: snap(0) });
  assert.deepEqual(S2.applied.marks.top, [0.5, 0.2]);
  assert.deepEqual(S2.draft, S2.applied); assert.notEqual(S2.draft, S2.applied);
  assert.equal(S2.dirty, false); assert.equal(S2.redo, null);
  assert.equal(S2.history.length, 1); assert.deepEqual(S2.history[0], snap(0));
});

test('undo pops the last entry into applied and draft and fills the redo slot; redo re-applies and clears it', () => {
  let S = createDraftState(applied0);
  S = reduce(S, { type: 'edit', patch: { marks: { top: [0.5, 0.2] } } });
  S = reduce(S, { type: 'apply', snapshot: snap(0) });          // history: [snap0]; applied top 0.2
  const current = snap(1);                                        // what the caller says is applied now
  const U = reduce(S, { type: 'undo', snapshot: current });
  assert.equal(U.history.length, 0);
  assert.deepEqual(U.redo, current, 'the undone state waits in the redo slot');
  assert.deepEqual(U.applied, { marks: snap(0).calibration.marks, dims: snap(0).venue.dims, house: snap(0).venue.house });
  assert.deepEqual(U.draft, U.applied); assert.equal(U.dirty, false);
  assert.equal(reduce(U, { type: 'undo', snapshot: current }), U, 'nothing left to undo: unchanged');
  const R = reduce(U, { type: 'redo', snapshot: snap(0) });
  assert.equal(R.redo, null);
  assert.deepEqual(R.applied, { marks: current.calibration.marks, dims: current.venue.dims, house: current.venue.house });
  assert.equal(R.history.length, 1); assert.deepEqual(R.history[0], snap(0));
  assert.equal(reduce(R, { type: 'redo', snapshot: snap(0) }), R, 'empty redo slot: unchanged');
});

test('a new apply after an undo clears the redo slot', () => {
  let S = createDraftState(applied0);
  S = reduce(S, { type: 'apply', snapshot: snap(0) });
  S = reduce(S, { type: 'undo', snapshot: snap(1) });
  assert.ok(S.redo);
  S = reduce(S, { type: 'edit', patch: { dims: { depth_ft: 31 } } });
  S = reduce(S, { type: 'apply', snapshot: snap(2) });
  assert.equal(S.redo, null);
  assert.deepEqual(S.history.map((h) => h.venue.dims.width_ft), [42]);
});

test('history keeps the last 10 entries', () => {
  assert.equal(HISTORY_CAP, 10);
  let S = createDraftState(applied0);
  for (let i = 1; i <= 11; i++) S = reduce(S, { type: 'apply', snapshot: snap(i) });
  assert.equal(S.history.length, 10);
  assert.deepEqual(S.history.map((h) => h.venue.dims.width_ft), [42, 43, 44, 45, 46, 47, 48, 49, 50, 51]);
});

test('clear removes the applied calibration, installs the default-pose draft, and is undoable', () => {
  let S = createDraftState(applied0);
  const pose = { marks: { ...record.marks, top: [0.5, 0.3] }, dims: DIMS, house: HOUSE };
  S = reduce(S, { type: 'clear', snapshot: snap(0), draft: pose });
  assert.equal(S.applied, null);
  assert.deepEqual(S.draft, pose); assert.notEqual(S.draft, pose);
  assert.equal(S.dirty, false); assert.equal(S.redo, null);
  assert.equal(S.history.length, 1);
  const U = reduce(S, { type: 'undo', snapshot: { calibration: null, venue: { dims: DIMS, house: HOUSE }, fixtures: [] } });
  assert.deepEqual(U.applied.marks, snap(0).calibration.marks);
  assert.equal(U.redo.calibration, null);
});

test('serializeUndo returns the latest entry; hydrateUndo seeds the history with it', () => {
  let S = createDraftState(applied0);
  assert.equal(serializeUndo(S), null);
  S = reduce(S, { type: 'apply', snapshot: snap(0) });
  S = reduce(S, { type: 'apply', snapshot: snap(1) });
  const entry = serializeUndo(S);
  assert.deepEqual(entry, snap(1));
  const fresh = hydrateUndo(createDraftState(applied0), JSON.parse(JSON.stringify(entry)));
  assert.equal(fresh.history.length, 1); assert.deepEqual(fresh.history[0], snap(1));
  assert.equal(hydrateUndo(createDraftState(applied0), null).history.length, 0);
  const U = reduce(fresh, { type: 'undo', snapshot: snap(2) });
  assert.deepEqual(U.applied.dims, snap(1).venue.dims);
});
