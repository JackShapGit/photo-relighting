// Minimal WebGL2 renderer for the relighting playground.
// Loads textures from /prepare URLs, runs a fullscreen quad through relight.frag.
// Public API: init(canvas), setAssets(urls), setLights(lights, ambient), draw().

import { computeReflectorEmission } from './reflector-emission.js';
import { effectiveFit, engineToWorld, engineDirToWorld } from '../metric/calibration.js';

let gl, program, vao, locs;
let texOriginal, texDepth, texNormals, texMask, texConfidence;
const goboTextures = new Map();   // gobo_id -> WebGLTexture

// ---------------------------------------------------------------------------
// Multi-pass accumulation. relight.frag lights at most MAX_LIGHTS_PER_PASS
// emitters per draw; scenes with more are rendered in chunks into a linear
// accumulation target (additive blend) and blitted once through the shared
// output stage. Reflectors and ambient are added in the first pass only.
// ---------------------------------------------------------------------------
export const MAX_LIGHTS_PER_PASS = 8;    // == MAX_LIGHTS in relight.frag
export const MAX_EMITTERS = 64;          // defensive cap; the UI enforces it too

/** Enabled emitters (reflectors excluded) in chunks of MAX_LIGHTS_PER_PASS,
 * truncated at MAX_EMITTERS. Pure. */
export function chunkEmitters(emitters) {
  const enabled = (emitters || [])
    .filter((L) => L && L.enabled !== false && L.type !== 'reflector')
    .slice(0, MAX_EMITTERS);
  const chunks = [];
  for (let i = 0; i < enabled.length; i += MAX_LIGHTS_PER_PASS) {
    chunks.push(enabled.slice(i, i + MAX_LIGHTS_PER_PASS));
  }
  return chunks;
}

// Shared output stage: clamp, refine-mode mask overlay, linear → sRGB encode
// (IEC 61966-2-1 piecewise, matching engine io._linear_to_srgb). Injected into
// relight.frag (single-pass path) and the blit program (multi-pass path) at
// the //__OUTPUT_STAGE__ marker so both encode identically. Without the
// encode, the RGBA8 canvas backbuffer (no sRGB framebuffer) would show linear
// mid-tones ~2× too dark versus the exported PNG.
export const OUTPUT_STAGE_GLSL = `
vec3 output_stage(vec3 total, float maskV) {
  total = clamp(total, vec3(0.0), vec3(1.0));
  // Refine-mode mask overlay: translucent blue over masked pixels, applied in
  // linear space, then encoded with everything else.
  if (u_maskOverlay == 1 && u_haveMask == 1) {
    vec3 tint = vec3(0.18, 0.45, 0.95);
    total = mix(total, tint, maskV * 0.45);
  }
  vec3 srgb = mix(
    total * 12.92,
    (1.0 + 0.055) * pow(max(total, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055,
    step(vec3(0.0031308), total)
  );
  return srgb;
}
`;
const OUTPUT_STAGE_MARKER = '//__OUTPUT_STAGE__';
export function injectOutputStage(src) {
  if (!src.includes(OUTPUT_STAGE_MARKER)) throw new Error('shader source lacks the //__OUTPUT_STAGE__ marker');
  return src.replace(OUTPUT_STAGE_MARKER, OUTPUT_STAGE_GLSL);
}

// Blit: accumulation texture → canvas through the shared output stage. The
// vertex shader flips v_uv.y into image space; the accumulation texture was
// written in framebuffer orientation, so sample it un-flipped.
const BLIT_FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 fragColor;
uniform sampler2D u_accum;
uniform sampler2D u_mask;
uniform int u_haveMask;
uniform int u_maskOverlay;
${OUTPUT_STAGE_MARKER}
void main() {
  vec3 total = texture(u_accum, vec2(v_uv.x, 1.0 - v_uv.y)).rgb;
  float maskV = u_haveMask == 1 ? texture(u_mask, v_uv).r : 1.0;
  fragColor = vec4(output_stage(total, maskV), 1.0);
}
`;
const ACCUM_UNIT = 13;                   // texture unit for the accumulation texture (gobos use 4..11, confidence 12)
let blitProgram = null, blitVao = null, blitLocs = null;
let accumFbo = null, accumTex = null, accumW = 0, accumH = 0;
let floatTargets = false, warnedNoFloat = false;

// ---------------------------------------------------------------------------
// Kelvin → linear-RGB, white-balanced to 5500 K (matches gels.py parity).
// ---------------------------------------------------------------------------
function _kelvinRaw(t) {
  // t is k/100 already, in [10, 400]. Returns un-normalized RGB.
  let r, g, b;
  if (t <= 66) r = 1.0;
  else r = Math.min(1, Math.max(0, 329.698727446 * Math.pow(t - 60, -0.1332047592) / 255));
  if (t <= 66) g = (99.4708025861 * Math.log(t) - 161.1195681661) / 255;
  else g = (288.1221695283 * Math.pow(t - 60, -0.0755148492)) / 255;
  g = Math.min(1, Math.max(0, g));
  if (t >= 66) b = 1.0;
  else if (t <= 19) b = 0.0;
  else b = Math.min(1, Math.max(0, (138.5177312231 * Math.log(t - 10) - 305.0447927307) / 255));
  return [r, g, b];
}

const _REF_5500 = _kelvinRaw(55);  // ~(1.0, 0.931, 0.871)

function kelvinToRGB(k) {
  k = Math.max(1000, Math.min(40000, k));
  const raw = _kelvinRaw(k / 100);
  return [
    Math.min(1, Math.max(0, raw[0] / _REF_5500[0])),
    Math.min(1, Math.max(0, raw[1] / _REF_5500[1])),
    Math.min(1, Math.max(0, raw[2] / _REF_5500[2])),
  ];
}

function resolveColor(L) {
  const isWhite = L.color[0] === 1 && L.color[1] === 1 && L.color[2] === 1;
  if (!isWhite) return L.color;
  if (L.color_temperature != null) return kelvinToRGB(L.color_temperature);
  return L.color;
}

export async function init(canvas) {
  gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 unavailable');

  const vsSrc = await (await fetch('/web/src/webgl/shaders/relight.vert')).text();
  const fsSrc = await (await fetch('/web/src/webgl/shaders/relight.frag')).text();
  program = compileProgram(vsSrc, injectOutputStage(fsSrc));

  // Fullscreen quad
  vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
  const a_pos = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(a_pos);
  gl.vertexAttribPointer(a_pos, 2, gl.FLOAT, false, 0, 0);

  // Multi-pass support: float render targets (RGBA16F) when the extension
  // exists, and the blit program with its own VAO over the same quad buffer.
  floatTargets = !!gl.getExtension('EXT_color_buffer_float');
  blitProgram = compileProgram(vsSrc, injectOutputStage(BLIT_FRAG));
  blitVao = gl.createVertexArray();
  gl.bindVertexArray(blitVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const b_pos = gl.getAttribLocation(blitProgram, 'a_pos');
  gl.enableVertexAttribArray(b_pos);
  gl.vertexAttribPointer(b_pos, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(vao);
  blitLocs = {
    u_accum: gl.getUniformLocation(blitProgram, 'u_accum'),
    u_mask: gl.getUniformLocation(blitProgram, 'u_mask'),
    u_haveMask: gl.getUniformLocation(blitProgram, 'u_haveMask'),
    u_maskOverlay: gl.getUniformLocation(blitProgram, 'u_maskOverlay'),
  };

  locs = {
    u_outputMode: gl.getUniformLocation(program, 'u_outputMode'),
    u_skipAmbient: gl.getUniformLocation(program, 'u_skipAmbient'),
    u_original: gl.getUniformLocation(program, 'u_original'),
    u_depth:    gl.getUniformLocation(program, 'u_depth'),
    u_normals:  gl.getUniformLocation(program, 'u_normals'),
    u_mask:     gl.getUniformLocation(program, 'u_mask'),
    u_confidence: gl.getUniformLocation(program, 'u_confidence'),
    u_haveMask: gl.getUniformLocation(program, 'u_haveMask'),
    u_haveConfidence: gl.getUniformLocation(program, 'u_haveConfidence'),
    u_shadowStyle: gl.getUniformLocation(program, 'u_shadowStyle'),
    u_subjectDepth: gl.getUniformLocation(program, 'u_subjectDepth'),
    u_maskOverlay: gl.getUniformLocation(program, 'u_maskOverlay'),
    u_ambient:  gl.getUniformLocation(program, 'u_ambient'),
    u_ambient_subject:    gl.getUniformLocation(program, 'u_ambient_subject'),
    u_ambient_background: gl.getUniformLocation(program, 'u_ambient_background'),
    u_lightCount: gl.getUniformLocation(program, 'u_lightCount'),
    u_debugView: gl.getUniformLocation(program, 'u_debugView'),
    // light array uniforms — per-field arrays of length 8
    ...buildLightUniformLocs(),
    u_goboTex: [...Array(8)].map((_, i) => gl.getUniformLocation(program, `u_goboTex[${i}]`)),
    // reflector uniforms
    u_reflectorCount:  gl.getUniformLocation(program, 'u_reflectorCount'),
    u_r_position:      gl.getUniformLocation(program, 'u_r_position'),
    u_r_normal:        gl.getUniformLocation(program, 'u_r_normal'),
    u_r_emission:      gl.getUniformLocation(program, 'u_r_emission'),
    u_r_dominant_dir:  gl.getUniformLocation(program, 'u_r_dominant_dir'),
    u_r_size:          gl.getUniformLocation(program, 'u_r_size'),
    u_r_roughness:     gl.getUniformLocation(program, 'u_r_roughness'),
    u_r_enabled:       gl.getUniformLocation(program, 'u_r_enabled'),
    u_r_affects:       gl.getUniformLocation(program, 'u_r_affects'),
  };
  // metric mode (calibrated scenes): camera + depth fit
  for (const name of ['u_metric', 'u_cam', 'u_cam2', 'u_fit']) locs[name] = gl.getUniformLocation(program, name);
}

function buildLightUniformLocs() {
  const fields = ['type', 'position', 'direction', 'color', 'intensity',
                  'falloff', 'cone_angle', 'softness', 'affects', 'enabled', 'hasGobo',
                  'goboScale', 'goboRotation', 'goboOffset', 'goboInvert',
                  // metric mode: engine-space proxies for shadow marching
                  'position_eng', 'direction_eng', 'shadowDir',
                  // linear lights: endpoint B (u_l_position carries A)
                  'endpoint_b', 'endpoint_b_eng'];
  const out = {};
  for (const f of fields) out[f] = gl.getUniformLocation(program, `u_l_${f}`);
  return out;
}

function compileProgram(vsSrc, fsSrc) {
  const vs = gl.createShader(gl.VERTEX_SHADER);
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs);
  if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(vs));
  const fs = gl.createShader(gl.FRAGMENT_SHADER);
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(fs));
  const p = gl.createProgram();
  gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);
  return p;
}

async function loadTexture(url, unit, { srgb = false, depth16 = false } = {}) {
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  const t = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  const internal = srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8;
  const fmt = gl.RGBA;
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, fmt, gl.UNSIGNED_BYTE, img);
  return t;
}

export async function setAssets(urls, canvas) {
  // Resize canvas to native asset dim (capped to fit viewport).
  // The asset PNG carries the right size already.
  texOriginal = await loadTexture(urls.original_png_url, 0, { srgb: true });
  texDepth    = await loadTexture(urls.depth_png_url,    1);
  texNormals  = await loadTexture(urls.normals_png_url,  2);
  texMask     = urls.mask_png_url
                ? await loadTexture(urls.mask_png_url,   3)
                : null;
  texConfidence = urls.confidence_png_url
                ? await loadTexture(urls.confidence_png_url, 12)
                : null;
}

// Hot-swap the mask texture (used after /refine_mask returns a new mask.png).
export async function reloadMaskTexture(url) {
  if (!url) return;
  texMask = await loadTexture(url, 3);
}

export async function ensureGoboTexture(goboId) {
  if (goboTextures.has(goboId)) return goboTextures.get(goboId);
  const slug = goboId.replace(/^preset:/, '');
  const url = `/static/gobos/${slug}.png`;
  const img = await new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url;
  });
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, img);
  goboTextures.set(goboId, t);
  return t;
}

/** Lazily (re)allocate the accumulation target at the canvas size. Returns
 * false when no complete framebuffer could be made (caller falls back). */
function ensureAccumTarget(w, h) {
  if (accumFbo && accumW === w && accumH === h) return true;
  if (!accumTex) accumTex = gl.createTexture();
  if (!accumFbo) accumFbo = gl.createFramebuffer();
  if (!floatTargets && !warnedNoFloat) {
    warnedNoFloat = true;
    console.warn('multi-pass accumulation without float render targets; banding possible');
  }
  gl.activeTexture(gl.TEXTURE0 + ACCUM_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, accumTex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  if (floatTargets) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.bindFramebuffer(gl.FRAMEBUFFER, accumFbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, accumTex, 0);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) console.warn('multi-pass accumulation framebuffer incomplete; rendering the first 8 lights only');
  accumW = ok ? w : 0; accumH = ok ? h : 0;
  return ok;
}

export function draw(state) {
  const c = gl.canvas;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  gl.viewport(0, 0, c.width, c.height);
  gl.useProgram(program);
  gl.bindVertexArray(vao);

  const cal = uploadFrameUniforms(state);

  const allLights = state.lights || [];
  const reflectors = allLights.filter((L) => L.type === 'reflector');
  const emitters   = allLights.filter((L) => L.type !== 'reflector');
  const reflEmission = computeReflectorEmission(allLights);
  state.gelResolved = emitters.map(L => ({ ...L, color: resolveColor(L) }));
  const resolved = (chunk) => chunk.map((L) => ({ ...L, color: resolveColor(L) }));
  uploadReflectors(reflectors, reflEmission);

  const chunks = chunkEmitters(emitters);
  const multi = chunks.length > 1
    && encodeDebugView(state.debugView) === 0
    && ensureAccumTarget(c.width, c.height);

  if (!multi) {
    // Single pass straight to the canvas: today's path.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.disable(gl.BLEND);
    gl.uniform1i(locs.u_outputMode, 0);
    gl.uniform1i(locs.u_skipAmbient, 0);
    const chunk = chunks[0] || [];
    uploadLights(chunk, resolved(chunk), cal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return;
  }

  // Multi-pass: linear accumulation of 8-light chunks, then one blit.
  gl.bindFramebuffer(gl.FRAMEBUFFER, accumFbo);
  gl.viewport(0, 0, c.width, c.height);
  gl.uniform1i(locs.u_outputMode, 1);
  chunks.forEach((chunk, k) => {
    gl.uniform1i(locs.u_skipAmbient, k > 0 ? 1 : 0);
    if (k === 0) {
      gl.disable(gl.BLEND);
    } else {
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
    }
    uploadLights(chunk, resolved(chunk), cal);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  });
  gl.disable(gl.BLEND);

  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, c.width, c.height);
  gl.useProgram(blitProgram);
  gl.bindVertexArray(blitVao);
  gl.activeTexture(gl.TEXTURE0 + ACCUM_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, accumTex);
  gl.uniform1i(blitLocs.u_accum, ACCUM_UNIT);
  gl.uniform1i(blitLocs.u_mask, 3);
  gl.uniform1i(blitLocs.u_haveMask, texMask ? 1 : 0);
  gl.uniform1i(blitLocs.u_maskOverlay, state.refineMode ? 1 : 0);
  gl.drawArrays(gl.TRIANGLES, 0, 3);

  // Restore the default state the rest of the renderer assumes.
  gl.useProgram(program);
  gl.bindVertexArray(vao);
}

/** Per-frame uniforms shared by every pass (textures, ambient, shadows,
 * metric camera). Returns the calibration to hand to uploadLights, or null. */
function uploadFrameUniforms(state) {
  gl.uniform1i(locs.u_original, 0);
  gl.uniform1i(locs.u_depth, 1);
  gl.uniform1i(locs.u_normals, 2);
  gl.uniform1i(locs.u_mask, 3);
  gl.uniform1i(locs.u_confidence, 12);
  gl.uniform1i(locs.u_haveMask, texMask ? 1 : 0);
  gl.uniform1i(locs.u_haveConfidence, texConfidence ? 1 : 0);
  const styleId = { off: 0, heightfield: 1, planar: 2 }[state.shadowStyle] ?? 0;
  gl.uniform1i(locs.u_shadowStyle, styleId);
  gl.uniform1f(locs.u_subjectDepth, state.subjectMedianDepth ?? 0.3);
  gl.uniform1i(locs.u_maskOverlay, state.refineMode ? 1 : 0);
  gl.uniform1f(locs.u_ambient, state.ambient);
  const aSubj = state.ambientLinked === false && state.ambientSubject != null
    ? state.ambientSubject : state.ambient;
  const aBg = state.ambientLinked === false && state.ambientBackground != null
    ? state.ambientBackground : state.ambient;
  gl.uniform1f(locs.u_ambient_subject, aSubj);
  gl.uniform1f(locs.u_ambient_background, aBg);
  gl.uniform1i(locs.u_debugView, encodeDebugView(state.debugView));

  // Metric mode: cal.camera is the solved CameraModel stored on the record
  // (Task 8's solveRecord); the renderer never solves. Without it the shader
  // runs the engine-space path unchanged.
  const cal = state.calibration;
  if (cal && cal.camera) {
    const c = cal.camera;
    gl.uniform1i(locs.u_metric, 1);
    gl.uniform4f(locs.u_cam, c.f, c.dist_ft, c.height_ft, c.u_c);
    gl.uniform4f(locs.u_cam2, c.va_h, c.k_y, c.aspect, cal.depth_ft);
    const fit = cal.depth_fit;
    gl.uniform3f(locs.u_fit, fit ? fit.a : 0, fit ? fit.b : 0, fit ? 1 : 0);
  } else {
    gl.uniform1i(locs.u_metric, 0);
  }
  return cal && cal.camera ? cal : null;
}

function encodeDebugView(v) {
  return { render: 0, depth: 1, normals: 2, mask: 3 }[v] ?? 0;
}

function uploadLights(lights, lightsResolved, cal = null) {
  const N = Math.min(lights.length, 8);
  gl.uniform1i(locs.u_lightCount, N);
  // Pack arrays
  const types = new Int32Array(8);
  const pos = new Float32Array(8 * 3), dir = new Float32Array(8 * 3), col = new Float32Array(8 * 3);
  const intensity = new Float32Array(8), falloff = new Float32Array(8);
  const cone = new Float32Array(8), soft = new Float32Array(8);
  const affects = new Int32Array(8), enabled = new Int32Array(8), hasGobo = new Int32Array(8);
  // Metric mode: lighting-space arrays carry feet (position_ft/direction_ft,
  // set by the sync helper; a light that still lacks them is derived from its
  // engine position the same way the Python engine does). Shadow marching
  // uses the engine proxy position and the engine `direction` field — the
  // very field the server receives, so both march along one vector.
  const posEng = new Float32Array(8 * 3), dirEng = new Float32Array(8 * 3);
  const shadowDir = new Int32Array(8);
  // Linear lights: u_l_position carries endpoint A, these carry endpoint B.
  const endB = new Float32Array(8 * 3), endBEng = new Float32Array(8 * 3);
  const metric = !!cal;
  const fit = metric ? effectiveFit(cal) : null;
  for (let i = 0; i < N; i++) {
    const L = lights[i], R = lightsResolved[i] ?? L;
    types[i] = { directional: 0, point: 1, spotlight: 2, linear: 3 }[L.type];
    const linear = L.type === 'linear';
    let posSrc, posEngSrc, endBSrc, endBEngSrc;
    if (linear) {
      // Endpoints: feet when calibrated (engine proxies derived by the sync
      // helper, null when behind the camera), the engine pair otherwise.
      posSrc    = metric ? (L.endpoint_a_ft || L.position_ft || L.position) : (L.endpoint_a || L.position);
      endBSrc   = metric ? (L.endpoint_b_ft || L.position_ft || L.position) : (L.endpoint_b || L.position);
      posEngSrc = L.endpoint_a || L.position_eng || L.position;
      endBEngSrc = L.endpoint_b || L.position_eng || L.position;
      shadowDir[i] = metric && (!L.endpoint_a || !L.endpoint_b) ? 1 : 0;
    } else {
      posSrc = metric ? (L.position_ft || engineToWorld(L.position, cal.camera, fit)) : L.position;
      endBSrc = posSrc;
      posEngSrc = L.position_eng || L.position;
      endBEngSrc = posEngSrc;
      shadowDir[i] = metric && !L.position_eng ? 1 : 0;
    }
    const dirSrc = metric ? (L.direction_ft || engineDirToWorld(L.direction)) : L.direction;
    pos.set(posSrc, i * 3); dir.set(dirSrc, i * 3); col.set(R.color, i * 3);
    posEng.set(posEngSrc, i * 3);
    dirEng.set(L.direction, i * 3);
    endB.set(endBSrc, i * 3); endBEng.set(endBEngSrc, i * 3);
    intensity[i] = L.intensity;
    falloff[i] = metric && L.falloff_ft != null ? L.falloff_ft : L.falloff;
    cone[i] = L.cone_angle; soft[i] = L.softness;
    affects[i] = { all: 0, subject: 1, background: 2 }[L.affects];
    enabled[i] = L.enabled ? 1 : 0;
    hasGobo[i] = L.gobo && !linear ? 1 : 0;        // linear lights carry no gobo
  }
  gl.uniform1iv(locs.type, types);
  gl.uniform3fv(locs.position, pos);
  gl.uniform3fv(locs.direction, dir);
  gl.uniform3fv(locs.color, col);
  gl.uniform1fv(locs.intensity, intensity);
  gl.uniform1fv(locs.falloff, falloff);
  gl.uniform1fv(locs.cone_angle, cone);
  gl.uniform1fv(locs.softness, soft);
  gl.uniform1iv(locs.affects, affects);
  gl.uniform1iv(locs.enabled, enabled);
  gl.uniform1iv(locs.hasGobo, hasGobo);
  gl.uniform3fv(locs.position_eng, posEng);
  gl.uniform3fv(locs.direction_eng, dirEng);
  gl.uniform1iv(locs.shadowDir, shadowDir);
  gl.uniform3fv(locs.endpoint_b, endB);
  gl.uniform3fv(locs.endpoint_b_eng, endBEng);

  // Gobo transform arrays
  const goboScale = new Float32Array(8);
  const goboRotation = new Float32Array(8);
  const goboOffset = new Float32Array(8 * 2);
  const goboInvert = new Int32Array(8);
  for (let i = 0; i < N; i++) {
    const L = lights[i];
    if (L.gobo) {
      goboScale[i] = L.gobo.scale ?? 1;
      goboRotation[i] = L.gobo.rotation ?? 0;
      goboOffset[i * 2] = L.gobo.offset?.[0] ?? 0;
      goboOffset[i * 2 + 1] = L.gobo.offset?.[1] ?? 0;
      goboInvert[i] = L.gobo.invert ? 1 : 0;
    }
  }

  // Bind gobo textures to units 4..11 and set sampler uniforms
  for (let i = 0; i < N; i++) {
    if (lights[i].gobo) {
      const tex = goboTextures.get(lights[i].gobo.texture_id);
      if (tex) {
        gl.activeTexture(gl.TEXTURE0 + 4 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      }
    }
  }
  for (let i = 0; i < 8; i++) {
    if (locs.u_goboTex[i] !== null) gl.uniform1i(locs.u_goboTex[i], 4 + i);
  }

  gl.uniform1fv(locs.goboScale, goboScale);
  gl.uniform1fv(locs.goboRotation, goboRotation);
  gl.uniform2fv(locs.goboOffset, goboOffset);
  gl.uniform1iv(locs.goboInvert, goboInvert);
}

function uploadReflectors(reflectors, reflEmission) {
  const MAX_REFLECTORS = 4;
  const rCount = Math.min(reflectors.length, MAX_REFLECTORS);
  gl.uniform1i(locs.u_reflectorCount, rCount);

  const flatVec3 = (arr) => {
    const out = new Float32Array(MAX_REFLECTORS * 3);
    for (let i = 0; i < rCount; i++) {
      out[i*3+0] = arr[i][0]; out[i*3+1] = arr[i][1]; out[i*3+2] = arr[i][2];
    }
    return out;
  };
  const flatVec2 = (arr) => {
    const out = new Float32Array(MAX_REFLECTORS * 2);
    for (let i = 0; i < rCount; i++) {
      out[i*2+0] = arr[i][0]; out[i*2+1] = arr[i][1];
    }
    return out;
  };

  const positions = reflectors.map((r) => r.position || [0,0,0]);
  const normals   = reflectors.map((r) => r.normal   || [0,0,1]);
  const emissions = reflEmission.map((r) => r.emission || [0,0,0]);
  const domDirs   = reflEmission.map((r) => r.dominantDir || [0,0,1]);
  const sizes     = reflectors.map((r) => r.size || [0.6, 0.4]);
  const rough     = new Float32Array(MAX_REFLECTORS);
  const enabled   = new Int32Array(MAX_REFLECTORS);
  const affects   = new Int32Array(MAX_REFLECTORS);
  for (let i = 0; i < rCount; i++) {
    rough[i]   = reflectors[i].roughness ?? 0.5;
    enabled[i] = reflectors[i].enabled === false ? 0 : 1;
    affects[i] = reflectors[i].affects === 'subject' ? 1
              : reflectors[i].affects === 'background' ? 2 : 0;
  }

  gl.uniform3fv(locs.u_r_position,     flatVec3(positions));
  gl.uniform3fv(locs.u_r_normal,       flatVec3(normals));
  gl.uniform3fv(locs.u_r_emission,     flatVec3(emissions));
  gl.uniform3fv(locs.u_r_dominant_dir, flatVec3(domDirs));
  gl.uniform2fv(locs.u_r_size,         flatVec2(sizes));
  gl.uniform1fv(locs.u_r_roughness,    rough);
  gl.uniform1iv(locs.u_r_enabled,      enabled);
  gl.uniform1iv(locs.u_r_affects,      affects);
}
