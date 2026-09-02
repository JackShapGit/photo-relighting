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

/** Both derived readings of a deck height: "12.0 ft above house floor · 4.0 ft below ceiling". */
export function describeHeight(deckValue, house, units = 'ft') {
  const above = fromDeck(deckValue, 'house_floor', house);
  const below = fromDeck(deckValue, 'ceiling', house);
  return `${formatLength(above, units)} above house floor · ${formatLength(below, units)} below ceiling`;
}
