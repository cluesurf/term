// Geometry for the {3,4,3,4} vibe-lattice view, provided to Seed via <global:lattice> so the .tree side stays clean
// (no raw GLSL, no `new Float32Array(...)`). This is the runtime-shim pattern (like http's transport.ts): the build
// prepends it next to the module that docks `<global:lattice>`.
//
// The committed vibe substrate is the 24-cell, the D4 "coin" of 24 directions. Its vertices are every permutation of
// (+/-1, +/-1, 0, 0) in 4D (24 of them); its edges join the vertex pairs at Euclidean distance sqrt(2) (the nearest
// neighbors, 96 edges). We draw the 24-cell's edge graph as a 2D shadow: the vertices are projected onto the F4
// Coxeter plane, the plane whose rotational symmetry is the Coxeter number h = 12, so the shadow carries the
// twelve-fold symmetry of the lattice. The drawing is fully deterministic (no random): the same coin always yields the
// same picture. The render uploads the projected edge endpoints and draws them as LINES.

// --- the 24 vertices of the 24-cell: all permutations of (+/-1, +/-1, 0, 0) ---
function buildVertices(): number[][] {
  const verts: number[][] = []
  // choose the two axes that carry the +/-1 entries, then their signs
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) {
      for (const sa of [1, -1]) {
        for (const sb of [1, -1]) {
          const v = [0, 0, 0, 0]
          v[a] = sa
          v[b] = sb
          verts.push(v)
        }
      }
    }
  }
  return verts
}

const dot = (p: number[], q: number[]) =>
  p.reduce((s, x, i) => s + x * q[i], 0)
const norm = (p: number[]) => Math.sqrt(dot(p, p))

// reflect a vector through the hyperplane perpendicular to a root
function reflect(v: number[], root: number[]): number[] {
  const f = (2 * dot(v, root)) / dot(root, root)
  return v.map((x, i) => x - f * root[i])
}

// --- the true F4 Coxeter-plane projection (Coxeter number h = 12) ---
// The 24-cell's symmetry group is F4. Its Coxeter element c (the product of the four simple reflections) has order 12
// and a single invariant 2-plane, the Coxeter plane, on which c acts as a rotation by 2*pi/12. Projecting the vertices
// onto that plane gives the canonical twelve-fold-symmetric shadow. We find the plane without an eigensolver: the
// projector onto the eigenline of eigenvalue exp(i*pi/6) is the phase-weighted sum of the powers of c, so applying it
// to a generic vector yields a complex vector whose real and imaginary parts span the Coxeter plane.
function projectionBasis(): { u: number[]; w: number[] } {
  // F4 simple roots (two long, two short)
  const roots = [
    [1, -1, 0, 0],
    [0, 1, -1, 0],
    [0, 0, 1, 0],
    [-0.5, -0.5, -0.5, -0.5],
  ]
  // Coxeter element c = s0 . s1 . s2 . s3 (apply s3 first)
  const coxeter = (v: number[]): number[] =>
    reflect(
      reflect(reflect(reflect(v, roots[3]), roots[2]), roots[1]),
      roots[0],
    )

  // a generic seed vector, off every symmetry axis
  let p = [1, 0.3, -0.7, 0.2]
  const step = Math.PI / 6 // 2*pi / h, h = 12
  let re = [0, 0, 0, 0]
  let im = [0, 0, 0, 0]
  for (let k = 0; k < 12; k++) {
    const c = Math.cos(k * step)
    const s = Math.sin(k * step)
    for (let i = 0; i < 4; i++) {
      re[i] += c * p[i]
      im[i] -= s * p[i]
    }
    p = coxeter(p)
  }
  // orthonormalize (re, im) into the projection basis
  const u = re.map(x => x / norm(re))
  const proj = dot(im, u)
  const wo = im.map((x, i) => x - proj * u[i])
  const w = wo.map(x => x / norm(wo))
  return { u, w }
}

function build(): { vertices: Float32Array; count: number } {
  const verts = buildVertices()
  const { u, w } = projectionBasis()

  // project each 4D vertex to 2D on the Coxeter plane
  const flat = verts.map(v => [dot(v, u), dot(v, w)])

  // edges: vertex pairs at squared distance 2 (the sqrt(2) nearest neighbors)
  const points: number[] = []
  let maxR = 1e-9
  for (const [x, y] of flat) maxR = Math.max(maxR, Math.hypot(x, y))
  const scale = 0.92 / maxR // fit inside clip space with a small margin

  for (let i = 0; i < verts.length; i++) {
    for (let j = i + 1; j < verts.length; j++) {
      let d2 = 0
      for (let k = 0; k < 4; k++) {
        const diff = verts[i][k] - verts[j][k]
        d2 += diff * diff
      }
      if (Math.abs(d2 - 2) < 1e-9) {
        points.push(flat[i][0] * scale, flat[i][1] * scale)
        points.push(flat[j][0] * scale, flat[j][1] * scale)
      }
    }
  }

  return {
    vertices: new Float32Array(points),
    count: points.length / 2,
  }
}

const geometry = build()

// edge endpoints as 2-floats-per-vertex, drawn as LINES (each consecutive pair is one segment)
export const vertices = geometry.vertices

// number of vertices to draw (2 per edge)
export const count = geometry.count

export const vertexSource = `#version 300 es
in vec2 pos;
void main() {
  gl_Position = vec4(pos, 0.0, 1.0);
}`

export const fragmentSource = `#version 300 es
precision mediump float;
out vec4 color;
void main() {
  color = vec4(0.55, 0.78, 1.0, 1.0);
}`
