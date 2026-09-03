/** Pure segment geometry for the 3D ruler (no Three import, so node can test
 * it): each measurement's two endpoints and midpoint in the Three frame
 * (x = world X, y = world Y, z = −world Z; see coords.js worldFtToThree).
 * measure-overlay.js wraps these in THREE.Line and a label sprite. */
import { worldFtToThree } from './coords.js';
import { distanceFt } from '../metric/measure.js';

export function measureSegment(m) {
  return {
    a: worldFtToThree(m.a),
    b: worldFtToThree(m.b),
    mid: worldFtToThree([0, 1, 2].map((i) => (m.a[i] + m.b[i]) / 2)),
    lengthFt: distanceFt(m.a, m.b),
  };
}
