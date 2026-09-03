// Fixture type presets: what a conventional theatre instrument does to the
// engine light it drives (beam, edge, colour temperature, gobo support).
// Pure: no DOM, no Three.

const deg = (d) => (d / 2) * Math.PI / 180;   // field angle → engine half-angle (radians)

export const FIXTURE_TYPES = [
  { id: 'ers', label: 'ERS / Leko' }, { id: 'fresnel', label: 'Fresnel' }, { id: 'par', label: 'PAR' },
  { id: 'followspot', label: 'Followspot' }, { id: 'moving_head', label: 'Moving head' },
  { id: 'cyc', label: 'Cyc / strip' }, { id: 'other', label: 'Other' },
];

export const PAR_LAMPS = { VNSP: 12, NSP: 20, MFL: 35, WFL: 55 };

export const PRESETS = {
  ers:         { engineType: 'spotlight', optionKey: 'barrel_deg', optionValues: [19, 26, 36, 50], defaultOption: 26, softness: 0.05, kelvin: 3200, aimed: 'optional', gobo: true },
  fresnel:     { engineType: 'spotlight', optionKey: 'beam_deg', range: [10, 60], defaultOption: 30, softness: 0.4, kelvin: 3200, aimed: 'optional', gobo: false },
  par:         { engineType: 'spotlight', optionKey: 'lamp', optionValues: Object.keys(PAR_LAMPS), defaultOption: 'MFL', softness: 0.25, kelvin: 3200, aimed: 'optional', gobo: false },
  followspot:  { engineType: 'spotlight', fieldDeg: 8, softness: 0.05, kelvin: 5600, aimed: 'always', gobo: false },
  moving_head: { engineType: 'spotlight', optionKey: 'beam_deg', range: [10, 50], defaultOption: 20, softness: 0.2, kelvin: 5600, aimed: 'always', gobo: true },
  cyc:         { engineType: 'linear', optionKey: 'length_ft', defaultOption: 4, softness: 0.6, kelvin: 3200, aimed: 'none', gobo: false },
  other:       { engineType: 'spotlight', optionKey: 'beam_deg', range: [5, 90], defaultOption: 30, softness: 0.2, kelvin: 5600, aimed: 'optional', gobo: true },
};

export function fieldAngleFor(typeId, option) {
  const p = PRESETS[typeId];
  if (p.fieldDeg != null) return p.fieldDeg;
  if (typeId === 'par') return PAR_LAMPS[option ?? p.defaultOption];
  if (typeId === 'cyc') return null;
  return option ?? p.defaultOption;
}

export function applyFixturePreset(L, typeId, option) {
  const p = PRESETS[typeId]; if (!p) throw new Error(`unknown fixture type ${typeId}`);
  const opt = option ?? p.defaultOption;
  L.fixture = { ...(L.fixture || {}), type: typeId };
  if (p.optionKey) L.fixture[p.optionKey] = opt;
  L.type = p.engineType;
  const fa = fieldAngleFor(typeId, opt);
  if (fa != null) L.cone_angle = deg(fa);
  L.softness = p.softness;
  L.kelvin = p.kelvin; L.color_temperature = p.kelvin; L.gel_preset = null;
  if (!p.gobo) L.gobo = null;
  return L;
}
