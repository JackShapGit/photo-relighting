#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = (a_pos + 1.0) * 0.5;
  v_uv.y = 1.0 - v_uv.y;       // flip — image-space y down
  gl_Position = vec4(a_pos, 0.0, 1.0);
}
