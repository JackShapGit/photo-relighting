// Minimal WebGL2 renderer for the relighting playground.
// Loads textures from /prepare URLs, runs a fullscreen quad through relight.frag.
// Public API: init(canvas), setAssets(urls), setLights(lights, ambient), draw().

let gl, program, vao, locs;
let texOriginal, texDepth, texNormals, texMask;
const goboTextures = new Map();   // gobo_id -> WebGLTexture

export async function init(canvas) {
  gl = canvas.getContext('webgl2', { antialias: false, premultipliedAlpha: false });
  if (!gl) throw new Error('WebGL2 unavailable');

  const vsSrc = await (await fetch('/web/src/webgl/shaders/relight.vert')).text();
  const fsSrc = await (await fetch('/web/src/webgl/shaders/relight.frag')).text();
  program = compileProgram(vsSrc, fsSrc);

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

  locs = {
    u_original: gl.getUniformLocation(program, 'u_original'),
    u_depth:    gl.getUniformLocation(program, 'u_depth'),
    u_normals:  gl.getUniformLocation(program, 'u_normals'),
    u_mask:     gl.getUniformLocation(program, 'u_mask'),
    u_haveMask: gl.getUniformLocation(program, 'u_haveMask'),
    u_ambient:  gl.getUniformLocation(program, 'u_ambient'),
    u_lightCount: gl.getUniformLocation(program, 'u_lightCount'),
    u_debugView: gl.getUniformLocation(program, 'u_debugView'),
    // light array uniforms — per-field arrays of length 8
    ...buildLightUniformLocs(),
    u_goboTex: [...Array(8)].map((_, i) => gl.getUniformLocation(program, `u_goboTex[${i}]`)),
  };
}

function buildLightUniformLocs() {
  const fields = ['type', 'position', 'direction', 'color', 'intensity',
                  'falloff', 'cone_angle', 'softness', 'affects', 'enabled', 'hasGobo',
                  'goboScale', 'goboRotation', 'goboOffset', 'goboInvert'];
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
}

export function draw(state) {
  const c = gl.canvas;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  gl.viewport(0, 0, c.width, c.height);
  gl.useProgram(program);
  gl.bindVertexArray(vao);

  gl.uniform1i(locs.u_original, 0);
  gl.uniform1i(locs.u_depth, 1);
  gl.uniform1i(locs.u_normals, 2);
  gl.uniform1i(locs.u_mask, 3);
  gl.uniform1i(locs.u_haveMask, texMask ? 1 : 0);
  gl.uniform1f(locs.u_ambient, state.ambient);
  gl.uniform1i(locs.u_debugView, encodeDebugView(state.debugView));

  uploadLights(state.lights, state.gelResolved || state.lights);

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

function encodeDebugView(v) {
  return { render: 0, depth: 1, normals: 2, mask: 3 }[v] ?? 0;
}

function uploadLights(lights, lightsResolved) {
  const N = Math.min(lights.length, 8);
  gl.uniform1i(locs.u_lightCount, N);
  // Pack arrays
  const types = new Int32Array(8);
  const pos = new Float32Array(8 * 3), dir = new Float32Array(8 * 3), col = new Float32Array(8 * 3);
  const intensity = new Float32Array(8), falloff = new Float32Array(8);
  const cone = new Float32Array(8), soft = new Float32Array(8);
  const affects = new Int32Array(8), enabled = new Int32Array(8), hasGobo = new Int32Array(8);
  for (let i = 0; i < N; i++) {
    const L = lights[i], R = lightsResolved[i] ?? L;
    types[i] = { directional: 0, point: 1, spotlight: 2 }[L.type];
    pos.set(L.position, i * 3); dir.set(L.direction, i * 3); col.set(R.color, i * 3);
    intensity[i] = L.intensity; falloff[i] = L.falloff;
    cone[i] = L.cone_angle; soft[i] = L.softness;
    affects[i] = { all: 0, subject: 1, background: 2 }[L.affects];
    enabled[i] = L.enabled ? 1 : 0;
    hasGobo[i] = L.gobo ? 1 : 0;
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
  // gobo transforms uploaded in Task 26 when gobo controls land.
}
