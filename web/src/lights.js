// Pure data model. Mutating any field requires the caller to call render().
export function defaultLight(slot) {
  const presets = {
    // z>0 = behind the scene (per spec §4.2), z<0 = camera-side.
    // For a default-facing surface (normal +z), lights must be positioned/aimed
    // so Lvec has positive z — i.e. point lights at z>1, directionals with dir.z<0.
    key:  { type: 'spotlight',   position: [0.7, 0.3, 1.5], direction: [-0.3, 0.3, -1], intensity: 1.2, color: [1,1,1], kelvin: 5500 },
    fill: { type: 'directional', position: [0.2, 0.5, -0.4], direction: [ 0.4, 0.0, -1], intensity: 0.5, color: [1,1,1], kelvin: 4500 },
    rim:  { type: 'spotlight',   position: [0.5, 0.5,  0.5], direction: [ 0.0,-0.2,-1], intensity: 1.0, color: [1,1,1], kelvin: 7000 },
  };
  const p = presets[slot];
  return {
    type: p.type,
    position: p.position.slice(),
    direction: p.direction.slice(),
    color: p.color.slice(),
    color_temperature: p.kelvin,
    gel_preset: null,
    intensity: p.intensity,
    falloff: 1.0,
    cone_angle: 0.5,
    softness: 0.1,
    gobo: null,
    affects: 'all',
    enabled: true,
  };
}

export function newState() {
  return {
    sessionId: null,
    width: 0,
    height: 0,
    assetUrls: null,
    lights: [defaultLight('key'), defaultLight('fill'), defaultLight('rim')],
    ambient: 0.2,
    debugView: 'render',
  };
}
