// Height references (calibration cube spec): a hanging position's height can
// be stated above the deck (today's meaning), above the house floor, or as a
// drop below the ceiling. Stored trim_ft / boom heights stay deck-relative;
// these helpers convert and re-derive them when the house changes. Pure.
import { formatLength } from '../metric/units.js';

export const HEIGHT_REFS = ['deck', 'house_floor', 'ceiling'];

/** A stated height in the given reference → height above the deck. */
export function toDeck(value, ref, house) {
  switch (ref) {
    case 'house_floor': return value - (house?.floor_drop_ft ?? 0);
    case 'ceiling':     return (house?.ceiling_ft ?? 0) - value;
    default:            return value;
  }
}

/** Height above the deck → the number as stated in the given reference. */
export function fromDeck(deckValue, ref, house) {
  switch (ref) {
    case 'house_floor': return deckValue + (house?.floor_drop_ft ?? 0);
    case 'ceiling':     return (house?.ceiling_ft ?? 0) - deckValue;
    default:            return deckValue;
  }
}

/**
 * Re-derive deck-relative trims for positions stated against the house
 * floor or ceiling (from their kept `height_input_ft`) after the house
 * changed. Deck-referenced positions and booms are copied unchanged (a
 * boom's fixture heights live on the lights, not on the position).
 */
export function recomputePositionsForHouse(positions, house) {
  return (positions || []).map((p) => {
    const ref = p.height_ref || 'deck';
    if (p.kind !== 'pipe' || ref === 'deck' || !Number.isFinite(p.height_input_ft)) return { ...p };
    return { ...p, trim_ft: toDeck(p.height_input_ft, ref, house) };
  });
}

/**
 * Re-derive the deck heights of fixtures hung on booms whose position is
 * stated against the house floor or ceiling, from each fixture's kept
 * `height_input_ft`. Mutates the lights' fixture blocks; returns the count.
 */
export function recomputeBoomFixturesForHouse(lights, positions, house) {
  const byId = new Map((positions || []).map((p) => [p.id, p]));
  let n = 0;
  for (const L of lights || []) {
    const f = L?.fixture;
    if (!f?.position_id || !Number.isFinite(f.height_input_ft)) continue;
    const p = byId.get(f.position_id);
    if (!p || p.kind !== 'boom' || (p.height_ref || 'deck') === 'deck') continue;
    f.offset_ft = toDeck(f.height_input_ft, p.height_ref, house);
    n += 1;
  }
  return n;
}

/**
 * A boom's height reference changed between two copies of the positions:
 * re-state every fixture hung on it from its deck height in the new
 * reference (the stated number moves, the physical height does not), so
 * the recompute that follows a venue write cannot read a number stated in
 * the old reference. Deck drops the stated number. Mutates the fixture
 * blocks; returns the count.
 */
export function restateBoomFixturesForRefChange(lights, prevPositions, nextPositions, house) {
  const prev = new Map((prevPositions || []).map((p) => [p.id, p]));
  let n = 0;
  for (const p of nextPositions || []) {
    if (p.kind !== 'boom') continue;
    const before = prev.get(p.id);
    const ref = p.height_ref || 'deck';
    if (!before || (before.height_ref || 'deck') === ref) continue;
    for (const L of lights || []) {
      const f = L?.fixture;
      if (!f || f.position_id !== p.id || !Number.isFinite(f.offset_ft)) continue;
      if (ref === 'deck') delete f.height_input_ft; else f.height_input_ft = fromDeck(f.offset_ft, ref, house);
      n += 1;
    }
  }
  return n;
}

/** Switch a position's reference; the shown number converts so the physical height does not move. */
export function positionWithHeightRef(position, ref, house) {
  const next = { ...position, height_ref: ref };
  if (position.kind === 'pipe' && Number.isFinite(position.trim_ft)) {
    next.height_input_ft = fromDeck(position.trim_ft, ref, house);
  }
  return next;
}

/** A typed height in the position's reference → stored deck trim (pipes) plus the stated number. */
export function positionWithHeightInput(position, value, house) {
  const ref = position.height_ref || 'deck';
  const next = { ...position, height_input_ft: value };
  if (position.kind === 'pipe') next.trim_ft = toDeck(value, ref, house);
  return next;
}

/** A typed height for a fixture on a boom, in the boom's reference (mutates the fixture block). */
export function fixtureWithHeightInput(L, value, position, house) {
  const ref = position?.height_ref || 'deck';
  L.fixture.offset_ft = toDeck(value, ref, house);
  if (ref === 'deck') delete L.fixture.height_input_ft; else L.fixture.height_input_ft = value;
  return L;
}

/** Both derived readings of a deck height: "12.0 ft above house floor · 4.0 ft below ceiling". */
export function describeHeight(deckValue, house, units = 'ft') {
  const above = fromDeck(deckValue, 'house_floor', house);
  const below = fromDeck(deckValue, 'ceiling', house);
  return `${formatLength(above, units)} above house floor · ${formatLength(below, units)} below ceiling`;
}
