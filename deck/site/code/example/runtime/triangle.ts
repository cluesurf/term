// Demo triangle render data for the vibe page, provided to Seed via <global:triangle> so the .tree side never has to
// express raw multi-line GLSL strings or `new Float32Array(...)`. This is the runtime shim pattern (like http's
// transport.ts / base's postgres.ts): the build prepends this next to the module that docks `<global:triangle>`.
// The lattice geometry replaces these vertices later; the shaders stay (or grow) the same.

export const vertexSource = `#version 300 es
in vec2 pos;
void main() {
  gl_Position = vec4(pos, 0.0, 1.0);
}`

export const fragmentSource = `#version 300 es
precision mediump float;
out vec4 color;
void main() {
  color = vec4(0.2, 0.6, 1.0, 1.0);
}`

export const vertices = new Float32Array([
  0.0, 0.5, -0.5, -0.5, 0.5, -0.5,
])
