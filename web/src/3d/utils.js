/** Small shared helpers for the 3D viewport. */

// Convert a linear [r, g, b] (each 0..1) to a packed 0xRRGGBB hex int for
// THREE color setters. Clamps out-of-range components.
export function rgbToHex(rgb) {
  const r = Math.round(Math.min(1, Math.max(0, rgb[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, rgb[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, rgb[2])) * 255);
  return (r << 16) | (g << 8) | b;
}
