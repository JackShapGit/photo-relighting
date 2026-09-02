#version 300 es
precision highp float;
precision highp int;

#define MAX_LIGHTS 8

in vec2 v_uv;
out vec4 fragColor;

uniform sampler2D u_original;     // sRGB texture; sample → linear via internalformat
uniform sampler2D u_depth;        // R channel = depth
uniform sampler2D u_normals;      // (n*0.5 + 0.5) RGB
uniform sampler2D u_mask;
uniform sampler2D u_confidence;   // R channel = per-pixel depth confidence in [0, 1]
uniform int u_haveMask;
uniform int u_haveConfidence;
uniform int u_shadowStyle;        // 0 = off, 1 = heightfield, 2 = planar
uniform float u_subjectDepth;     // median depth of masked subject; ~0.3 fallback
uniform int u_maskOverlay;        // 0 = off, 1 = blue tint over masked pixels (refine mode)
uniform float u_ambient;
uniform float u_ambient_subject;
uniform float u_ambient_background;
uniform int u_debugView;

uniform int  u_l_type[MAX_LIGHTS];
uniform vec3 u_l_position[MAX_LIGHTS];
uniform vec3 u_l_direction[MAX_LIGHTS];
uniform vec3 u_l_color[MAX_LIGHTS];
uniform float u_l_intensity[MAX_LIGHTS];
uniform float u_l_falloff[MAX_LIGHTS];
uniform float u_l_cone_angle[MAX_LIGHTS];

// ── Metric mode (calibrated scenes) ──────────────────────────────────────
uniform int   u_metric;                 // 1 = positions in feet
uniform vec4  u_cam;                    // f, dist_ft, height_ft, u_c
uniform vec4  u_cam2;                   // va_h, k_y, aspect, depth_ft
uniform vec3  u_fit;                    // a, b, hasFit(0/1)
uniform vec3  u_l_position_eng[MAX_LIGHTS];   // engine-space proxy for shadow marching
uniform vec3  u_l_direction_eng[MAX_LIGHTS];
uniform int   u_l_shadowDir[MAX_LIGHTS];      // 1 = march along direction (light has no projection)
// Linear (cyc/strip) lights, type 3: u_l_position is endpoint A, these are B.
uniform vec3  u_l_endpoint_b[MAX_LIGHTS];      // lighting space (feet when metric)
uniform vec3  u_l_endpoint_b_eng[MAX_LIGHTS];  // engine-space proxy of B

float metric_zcam(float d) {
  if (u_fit.z < 0.5) return u_cam.y + d * u_cam2.w;     // no depth fit: linear over stage depth
  float inv = max(u_fit.x * d + u_fit.y, 1.0 / 10000.0);
  return clamp(1.0 / inv, 0.5, 10000.0);
}

vec3 metric_pixel_to_world(vec2 uv, float d) {
  float zc = metric_zcam(d);
  float X = (uv.x - u_cam.w) * zc / u_cam.x;
  float Y = u_cam2.y * (u_cam.z - (uv.y * u_cam2.z - u_cam2.x) * zc / u_cam.x);
  return vec3(X, Y, zc - u_cam.y);
}

uniform float u_l_softness[MAX_LIGHTS];
uniform int  u_l_affects[MAX_LIGHTS];
uniform int  u_l_enabled[MAX_LIGHTS];
uniform int  u_l_hasGobo[MAX_LIGHTS];
uniform sampler2D u_goboTex[MAX_LIGHTS];
uniform float u_l_goboScale[MAX_LIGHTS];
uniform float u_l_goboRotation[MAX_LIGHTS];
uniform vec2  u_l_goboOffset[MAX_LIGHTS];
uniform int   u_l_goboInvert[MAX_LIGHTS];

uniform int u_lightCount;

#define MAX_REFLECTORS 4

uniform int   u_reflectorCount;
uniform vec3  u_r_position[MAX_REFLECTORS];
uniform vec3  u_r_normal[MAX_REFLECTORS];
uniform vec3  u_r_emission[MAX_REFLECTORS];
uniform vec3  u_r_dominant_dir[MAX_REFLECTORS];
uniform vec2  u_r_size[MAX_REFLECTORS];
uniform float u_r_roughness[MAX_REFLECTORS];
uniform int   u_r_enabled[MAX_REFLECTORS];
uniform int   u_r_affects[MAX_REFLECTORS];

float saturate1(float x) { return clamp(x, 0.0, 1.0); }

vec2 ortho_uv(vec3 P, vec3 d_in) {
  vec3 d = normalize(d_in);
  vec3 up = abs(d.y) > 0.95 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  vec3 ux = normalize(cross(up, d));
  vec3 vx = normalize(cross(d, ux));
  return vec2(dot(P, ux), dot(P, vx)) + 0.5;
}

vec2 perspective_uv(vec3 P, vec3 pos, vec3 d_in, float cone_angle) {
  vec3 d = normalize(d_in);
  vec3 up = abs(d.y) > 0.95 ? vec3(1, 0, 0) : vec3(0, 1, 0);
  vec3 ux = normalize(cross(up, d));
  vec3 vx = normalize(cross(d, ux));
  vec3 rel = P - pos;
  float fwd = max(dot(rel, d), 1e-4);
  float pu = dot(rel, ux) / fwd;
  float pv = dot(rel, vx) / fwd;
  float half_t = tan(max(cone_angle, 1e-3));
  return vec2(0.5 + pu / (2.0 * half_t), 0.5 + pv / (2.0 * half_t));
}

vec2 equirect_uv(vec3 P, vec3 pos) {
  vec3 L = normalize(P - pos);
  float theta = atan(L.x, L.z);
  float phi = asin(clamp(L.y, -1.0, 1.0));
  return vec2(0.5 + theta / 6.283185, 0.5 + phi / 3.141593);
}

// Heightfield ray-march toward the light. Returns 1.0 if the ray reaches the
// light, 0.0 if the depth heightfield occludes it.
// Mirror of shaders.py::_shadow_factor.
float heightfield_shadow(vec3 P, vec3 L_vec) {
  const int STEPS = 16;
  const float MAX_DIST = 0.6;
  const float BIAS = 0.003;
  for (int i = 1; i <= STEPS; i++) {
    float t = float(i) / float(STEPS) * MAX_DIST;
    vec3 sp = P + L_vec * t;
    if (sp.x < 0.0 || sp.x > 1.0 || sp.y < 0.0 || sp.y > 1.0) break;
    float surface_z = texture(u_depth, sp.xy).r;
    if (surface_z + BIAS < sp.z) return 0.0;
  }
  return 1.0;
}

// Planar silhouette projection. Trace from each pixel toward the light; where
// the ray crosses the subject's plane (at u_subjectDepth) we sample the mask
// — if the subject is there, this pixel is in shadow. A small box-blur in
// shader form gives a soft penumbra.
// Mirror of shaders.py::_planar_shadow.
float planar_shadow(vec3 P, vec3 L_vec, float maskV) {
  if (u_haveMask == 0) return 1.0;
  float Rz = L_vec.z;
  // Clamp |Rz| away from zero (very oblique lights stretch infinitely).
  if (abs(Rz) < 0.05) Rz = (Rz >= 0.0 ? 0.05 : -0.05);
  float t = (u_subjectDepth - P.z) / Rz;
  if (t <= 0.0) return 1.0;            // subject is in front of us, can't shadow
  if (maskV >= 0.5) return 1.0;        // don't shadow subject pixels themselves

  vec2 sample_uv = P.xy + L_vec.xy * t;
  if (sample_uv.x < 0.0 || sample_uv.x > 1.0 ||
      sample_uv.y < 0.0 || sample_uv.y > 1.0) return 1.0;

  // 5×5 box-blur of the mask sample. Texture filtering already gives bilinear,
  // and the texelSize-based offsets give a small penumbra.
  vec2 px = 1.0 / vec2(textureSize(u_mask, 0));
  float acc = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      vec2 uv = sample_uv + vec2(float(dx), float(dy)) * px * 3.0;
      acc += texture(u_mask, uv).r;
    }
  }
  float occ = acc / 25.0;
  return clamp(1.0 - occ * 0.85, 0.0, 1.0);
}

float shadow_factor(vec3 P, vec3 L_vec, float maskV) {
  if (u_shadowStyle == 1) return heightfield_shadow(P, L_vec);
  if (u_shadowStyle == 2) return planar_shadow(P, L_vec, maskV);
  return 1.0;
}

float sample_gobo(int i, vec2 uv) {
  // WebGL2 doesn't allow dynamic indexing of sampler arrays; expand a switch.
  // For MVP we keep gobo sampling simple — only key/fill/rim use gobos via slots 0..2.
  if (i == 0) return texture(u_goboTex[0], uv).r;
  if (i == 1) return texture(u_goboTex[1], uv).r;
  if (i == 2) return texture(u_goboTex[2], uv).r;
  if (i == 3) return texture(u_goboTex[3], uv).r;
  if (i == 4) return texture(u_goboTex[4], uv).r;
  if (i == 5) return texture(u_goboTex[5], uv).r;
  if (i == 6) return texture(u_goboTex[6], uv).r;
  if (i == 7) return texture(u_goboTex[7], uv).r;
  return 1.0;
}

void main() {
  vec3 original = texture(u_original, v_uv).rgb;  // already linear (sRGB sampler)
  float depth = texture(u_depth, v_uv).r;
  vec3 N = texture(u_normals, v_uv).rgb * 2.0 - 1.0;
  N = normalize(N);
  float maskV = u_haveMask == 1 ? texture(u_mask, v_uv).r : 1.0;
  float confV = u_haveConfidence == 1 ? texture(u_confidence, v_uv).r : 1.0;

  if (u_debugView == 1) { fragColor = vec4(vec3(depth), 1.0); return; }
  if (u_debugView == 2) { fragColor = vec4(N * 0.5 + 0.5, 1.0); return; }
  if (u_debugView == 3) { fragColor = vec4(vec3(maskV), 1.0); return; }

  vec3 P = vec3(v_uv.x, v_uv.y, depth);            // engine space (shadows, gobo ortho)
  vec3 Pw = P;                                      // lighting-space position
  vec3 Nw = N;                                      // lighting-space normal
  if (u_metric == 1) {
    Pw = metric_pixel_to_world(v_uv, depth);
    Nw = vec3(N.x, -N.y, -N.z);
  }

  // Confidence weights only the per-light contributions (not ambient), so
  // low-confidence regions still get ambient illumination from the original.
  // Per-zone ambient: subject vs background blended by mask. When no mask is
  // present we fall back to the global ambient.
  float ambient_v = u_haveMask == 1
    ? mix(u_ambient_background, u_ambient_subject, maskV)
    : u_ambient;
  vec3 total = ambient_v * original;
  for (int i = 0; i < MAX_LIGHTS; i++) {
    if (i >= u_lightCount) break;
    if (u_l_enabled[i] == 0) continue;

    vec3 Lvec; float atten;
    vec3 Lvec_eng;                                   // engine-space vector for shadow marching
    float wrapDiff = -1.0;                           // <0 = not a linear light
    if (u_l_type[i] == 3) {  // linear (cyc/strip): lit from the closest point on the bar
      vec3 A = u_l_position[i], B = u_l_endpoint_b[i];
      vec3 AB = B - A;
      float t = clamp(dot(Pw - A, AB) / max(dot(AB, AB), 1e-9), 0.0, 1.0);
      vec3 Q = A + t * AB;
      vec3 d = Q - Pw; float dist = length(d) + 1e-6;
      Lvec = d / dist;
      atten = 1.0 / (1.0 + u_l_falloff[i] * dist * dist);
      float s = u_l_softness[i];
      wrapDiff = max(dot(Nw, Lvec) + s, 0.0) / (1.0 + s);
      vec3 Ae = u_l_position_eng[i], Be = u_l_endpoint_b_eng[i]; vec3 ABe = Be - Ae;
      float te = clamp(dot(P - Ae, ABe) / max(dot(ABe, ABe), 1e-9), 0.0, 1.0);
      Lvec_eng = (u_metric == 1 && u_l_shadowDir[i] == 0) ? normalize(Ae + te * ABe - P) : Lvec;
    } else if (u_l_type[i] == 0) {  // directional
      Lvec = normalize(-u_l_direction[i]);
      atten = 1.0;
      Lvec_eng = (u_metric == 1) ? normalize(-u_l_direction_eng[i]) : Lvec;
    } else {
      vec3 d = u_l_position[i] - Pw;
      float dist = length(d) + 1e-6;
      Lvec = d / dist;
      atten = 1.0 / (1.0 + u_l_falloff[i] * dist * dist);
      if (u_metric == 1) {
        Lvec_eng = (u_l_shadowDir[i] == 1)
          ? normalize(-u_l_direction_eng[i])
          : normalize(u_l_position_eng[i] - P);
      } else {
        Lvec_eng = Lvec;
      }
    }

    float cone = 1.0;
    if (u_l_type[i] == 2) {
      vec3 dn = normalize(u_l_direction[i]);
      float cone_dot = dot(dn, -Lvec);
      float inner = cos(max(u_l_cone_angle[i] - u_l_softness[i] * 0.5, 1e-4));
      float outer = cos(u_l_cone_angle[i] + u_l_softness[i] * 0.5);
      cone = saturate1((cone_dot - outer) / (inner - outer + 1e-6));
    }

    float gobo = 1.0;
    if (u_l_hasGobo[i] == 1) {
      vec2 uv;
      if (u_l_type[i] == 0)                                                // engine-space P and direction
        uv = ortho_uv(P, (u_metric == 1) ? u_l_direction_eng[i] : u_l_direction[i]);
      else if (u_l_type[i] == 2)
        uv = perspective_uv(Pw, u_l_position[i], u_l_direction[i], u_l_cone_angle[i]);
      else uv = equirect_uv(Pw, u_l_position[i]);
      vec2 c = uv - 0.5;
      float cs = cos(u_l_goboRotation[i]), sn = sin(u_l_goboRotation[i]);
      vec2 r = vec2(cs * c.x - sn * c.y, sn * c.x + cs * c.y);
      uv = r * u_l_goboScale[i] + 0.5 + u_l_goboOffset[i];
      gobo = sample_gobo(i, uv);
      if (u_l_goboInvert[i] == 1) gobo = 1.0 - gobo;
    }

    float diff = wrapDiff >= 0.0 ? wrapDiff : max(dot(Nw, Lvec), 0.0);
    float maskW = u_l_affects[i] == 0 ? 1.0
                : u_l_affects[i] == 1 ? maskV
                : (1.0 - maskV);

    float shadow = shadow_factor(P, Lvec_eng, maskV);
    total += original * u_l_color[i] * u_l_intensity[i] * diff * atten * cone * gobo * maskW * confV * shadow;
  }

  for (int i = 0; i < MAX_REFLECTORS; i++) {
    if (i >= u_reflectorCount) break;
    if (u_r_enabled[i] == 0) continue;

    // affects gating: 0=all, 1=subject, 2=background.
    float maskAffect = 1.0;
    if (u_r_affects[i] == 1) maskAffect = maskV;
    else if (u_r_affects[i] == 2) maskAffect = 1.0 - maskV;
    if (maskAffect <= 0.0) continue;

    vec3  R_pos   = u_r_position[i];
    vec3  R_norm  = u_r_normal[i];
    vec3  R_emit  = u_r_emission[i];
    vec3  R_refl  = u_r_dominant_dir[i];
    float rough   = u_r_roughness[i];
    vec2  R_size  = u_r_size[i];

    vec3 Lvec = R_pos - P;
    float dist = length(Lvec) + 1e-6;
    Lvec /= dist;

    float facing = max(0.0, dot(R_norm, -Lvec));
    if (facing <= 0.0) continue;

    float area  = R_size.x * R_size.y;
    float atten = area / (dist * dist + 1.0);

    float diffuse_w = rough;
    float ndotl     = max(0.0, dot(N, Lvec));
    vec3  diffuse_c = R_emit * ndotl * diffuse_w * facing * atten;

    float glossy_w     = 1.0 - rough;
    float lobe_sharp   = mix(2.0, 50.0, 1.0 - rough);
    float align        = max(0.0, dot(Lvec, R_refl));
    float lobe         = pow(align, lobe_sharp);
    vec3  glossy_c     = R_emit * lobe * glossy_w * facing * atten;

    total += maskAffect * (diffuse_c + glossy_c);
  }

  total = clamp(total, vec3(0.0), vec3(1.0));
  // Refine-mode mask overlay: blend a translucent blue over masked pixels so
  // the user can see what's currently selected. Applied in linear space then
  // sRGB-encoded below with everything else.
  if (u_maskOverlay == 1 && u_haveMask == 1) {
    vec3 tint = vec3(0.18, 0.45, 0.95);
    total = mix(total, tint, maskV * 0.45);
  }
  // Linear → sRGB (IEC 61966-2-1 piecewise) — matches engine io._linear_to_srgb.
  // Without this, the canvas backbuffer (RGBA8, no sRGB framebuffer) makes linear
  // mid-tones display ~2× too dark vs the exported PNG (which is sRGB-encoded + ICC-tagged).
  vec3 srgb = mix(
    total * 12.92,
    (1.0 + 0.055) * pow(max(total, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), total)
  );
  fragColor = vec4(srgb, 1.0);
}
