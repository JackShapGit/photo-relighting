// Fixture-library presets for the "+ Add Light" picker. Each preset stamps a
// new LightNode with sensible defaults — type, position, direction, Kelvin,
// intensity, cone/softness/falloff. The user can adjust any field afterward.
//
// The icon is a plain Unicode glyph; Step 4 will replace these with
// pre-rendered thumbnail PNGs under /static/preset-thumbs/.

export const PRESETS = [
  {
    id: 'sun',
    name: 'Sun',
    icon: '☀',
    description: 'Hard parallel light, daylight 5500 K',
    fields: {
      type: 'directional',
      position: [0.5, 0.5, 1.0],
      direction: [-0.4, 0.5, -0.8],
      color_temperature: 5500,
      intensity: 1.5,
      falloff: 0.0,
      cone_angle: 0.5,
      softness: 0.1,
    },
  },
  {
    id: 'skylight',
    name: 'Skylight',
    icon: '☁',
    description: 'Soft cool fill, no shadow, 7500 K',
    fields: {
      type: 'directional',
      position: [0.5, 0.5, 1.0],
      direction: [0.0, -1.0, -0.3],
      color_temperature: 7500,
      intensity: 0.4,
      falloff: 0.0,
      cone_angle: 0.5,
      softness: 0.1,
    },
  },
  {
    id: 'softbox',
    name: 'Softbox',
    icon: '◻',
    description: 'Broad neutral fill, 5300 K',
    fields: {
      type: 'directional',
      position: [0.5, 0.5, 1.0],
      direction: [0.5, 0.2, -1.0],
      color_temperature: 5300,
      intensity: 0.8,
      falloff: 0.0,
      cone_angle: 0.5,
      softness: 0.1,
    },
  },
  {
    id: 'tungsten',
    name: 'Tungsten',
    icon: '💡',
    description: 'Warm spotlight, 3200 K',
    fields: {
      type: 'spotlight',
      position: [0.85, 0.35, 1.0],
      direction: [-0.3, 0.2, -1.0],
      color_temperature: 3200,
      intensity: 0.9,
      falloff: 1.0,
      cone_angle: 0.45,
      softness: 0.10,
    },
  },
  {
    id: 'fresnel',
    name: 'Fresnel',
    icon: '◉',
    description: 'Tight controllable spot, 5500 K',
    fields: {
      type: 'spotlight',
      position: [0.20, 0.30, 1.2],
      direction: [0.3, 0.2, -1.0],
      color_temperature: 5500,
      intensity: 1.1,
      falloff: 1.0,
      cone_angle: 0.50,
      softness: 0.08,
    },
  },
  {
    id: 'cone',
    name: 'Cone',
    icon: '▽',
    description: 'Generic key spot, 5500 K',
    fields: {
      type: 'spotlight',
      position: [0.50, 0.20, 1.0],
      direction: [0.0, 0.3, -1.0],
      color_temperature: 5500,
      intensity: 1.0,
      falloff: 1.0,
      cone_angle: 0.50,
      softness: 0.15,
    },
  },
  {
    id: 'strobe',
    name: 'Strobe',
    icon: '⚡',
    description: 'Punchy hard spot, 5500 K',
    fields: {
      type: 'spotlight',
      position: [0.85, 0.50, 0.8],
      direction: [-0.3, 0.0, -1.0],
      color_temperature: 5500,
      intensity: 1.6,
      falloff: 1.0,
      cone_angle: 0.30,
      softness: 0.05,
    },
  },
  {
    id: 'rim',
    name: 'Rim',
    icon: '◐',
    description: 'Backlight separation, 6500 K',
    fields: {
      // z=1.3 puts it outside the subject's depth range so the gizmo sits
      // visibly in front of the point cloud in the 3D viewport (previously
      // z=0.4 placed it inside the cloud and the gizmo was hard to grab).
      type: 'spotlight',
      position: [0.50, 0.50, 1.3],
      direction: [0.0, -0.2, -1.0],
      color_temperature: 6500,
      intensity: 1.2,
      falloff: 0.8,
      cone_angle: 0.40,
      softness: 0.10,
    },
  },
  {
    id: 'omni',
    name: 'Omni',
    icon: '⊙',
    description: 'Omnidirectional point source, 5000 K',
    fields: {
      // Point lights emit in all directions; direction and cone_angle are
      // ignored by the engine but the wire schema still requires them.
      type: 'point',
      position: [0.50, 0.50, 1.3],
      direction: [0.0, 0.0, -1.0],
      color_temperature: 5000,
      intensity: 1.0,
      falloff: 1.0,
      cone_angle: 0.5,
      softness: 0.1,
    },
  },
  {
    id: 'reflector',
    name: 'Reflector',
    icon: '▭',
    description: 'Bounce card — silver/white, 5000 K',
    fields: {
      type: 'reflector',
      position: [0.25, 0.55, -0.4],
      direction: [0, 0, -1],
      color_temperature: 5000,
      intensity: 1.0,
      falloff: 1.0,
      cone_angle: 0.5,
      softness: 0.1,
      normal: [0.5, 0.0, 1.0],
      size: [0.6, 0.4],
      reflectance: 0.7,
      roughness: 0.5,
    },
  },
];

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || null;
}
