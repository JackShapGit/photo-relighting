// Single source of unit conversion for the UI. Stored values are ALWAYS feet.
export const FT_PER_M = 1 / 0.3048;
export const UNITS = ['ft', 'm'];

export function toDisplay(ft, unit) {
  return unit === 'm' ? ft / FT_PER_M : ft;
}

export function fromDisplay(value, unit) {
  return unit === 'm' ? value * FT_PER_M : value;
}

export function formatLength(ft, unit, { precision = 1 } = {}) {
  const v = toDisplay(ft, unit);
  return `${v.toFixed(precision)} ${unit}`;
}

const FT_IN = /^\s*(-?\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*"?)?\s*$/;
const NUM_UNIT = /^\s*(-?\d+(?:\.\d+)?)\s*(ft|feet|m|meters?)?\s*$/i;

/** Parse user text into feet. `unit` is assumed when no suffix is given. */
export function parseLength(text, unit) {
  if (typeof text !== 'string') return null;
  const fi = text.match(FT_IN);
  if (fi) return parseFloat(fi[1]) + (fi[2] ? parseFloat(fi[2]) / 12 : 0);
  const m = text.match(NUM_UNIT);
  if (!m) return null;
  const v = parseFloat(m[1]);
  if (!Number.isFinite(v)) return null;
  const suffix = (m[2] || '').toLowerCase();
  if (suffix.startsWith('m')) return v * FT_PER_M;
  if (suffix) return v;
  return fromDisplay(v, unit);
}
