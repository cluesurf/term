// The hyperbolic substrate's space: a regular tiling {p, q} on which the interaction net is laid out and reduced.
// The defining property versus a Euclidean grid is exponential growth: the number of cells within distance n grows
// geometrically, so a finite patch has room for the net to spread without the crowding that throttles a flat grid.
// This is the tessellation-tree coordinatization (Margenstern): a spanning tree of the tiling, where the centre has
// p children and every later cell has p - 3 children (for q = 3, each cell shares one edge with its parent and two
// with its siblings). It captures the growth and the parent/child adjacency the placement needs; the full edge
// adjacency (Margenstern's coordinate automaton) is a deeper refinement. See plans/06-runtime-substrate.md.
// Pure and browser-safe.

import type { Net } from '@/code/ir/net'

export type Cell = { id: number; shell: number; parent: number; children: Array<number> }

// grow a tessellation tree: the centre cell has `centre` children, every later cell has `branch` children
function grow(centre: number, branch: number, shells: number): { cells: Array<Cell>; perShell: Array<number> } {
  const cells: Array<Cell> = [{ id: 0, shell: 0, parent: -1, children: [] }]
  const perShell = [1]
  let frontier = [0]
  for (let shell = 1; shell <= shells; shell++) {
    const nextFrontier: Array<number> = []
    for (const parentId of frontier) {
      const childCount = parentId === 0 ? centre : branch
      for (let k = 0; k < childCount; k++) {
        const id = cells.length
        cells.push({ id, shell, parent: parentId, children: [] })
        cells[parentId]!.children.push(id)
        nextFrontier.push(id)
      }
    }
    perShell.push(nextFrontier.length)
    frontier = nextFrontier
  }
  return { cells, perShell }
}

// the 2D regular hyperbolic tiling {p,3}: a cell shares one edge with its parent and two with siblings, leaving
// p - 3 child edges
export function lattice(p: number, q: number, shells: number): { cells: Array<Cell>; perShell: Array<number> } {
  if (q !== 3) throw new Error('lattice: only q = 3 is modeled')
  if (p < 5) throw new Error('lattice: {p,3} is hyperbolic only for p >= 5')
  return grow(p, p - 3, shells)
}

// the substrate's three realizations: the 2D {7,3} tiling, the 3D {5,3,4} dodecahedral honeycomb, and the 4D
// {3,4,3,4} (the 24-cell honeycomb). Each cell branches by roughly its facet count (12 faces for a dodecahedron,
// 24 for a 24-cell), minus the facets shared with parent and siblings. The defining feature carried across all
// three is exponential growth: more room than any Euclidean grid of the same dimension.
const HONEYCOMB: Record<string, { centre: number; branch: number }> = {
  '{7,3}': { centre: 7, branch: 4 },
  '{5,3,4}': { centre: 12, branch: 10 },
  '{3,4,3,4}': { centre: 24, branch: 22 },
}

export function honeycomb(schlafli: string, shells: number): { cells: Array<Cell>; perShell: Array<number> } {
  const spec = HONEYCOMB[schlafli]
  if (!spec) throw new Error(`honeycomb: ${schlafli} is not one of ${Object.keys(HONEYCOMB).join(', ')}`)
  return grow(spec.centre, spec.branch, shells)
}

// two cells are adjacent if one is the other's parent (the spanning-tree edges)
function adjacent(cells: Array<Cell>, a: number, b: number): boolean {
  return cells[a]!.parent === b || cells[b]!.parent === a
}

// lay a net's nodes onto cells in breadth-first order, then measure locality: the fraction of the net's wires whose
// two endpoints land on adjacent cells (so the local interaction rules touch neighbouring cells). Higher is better.
export function place(net: Net, cells: Array<Cell>): { placement: Map<number, number>; locality: number } {
  const placement = new Map<number, number>()
  let cell = 0
  for (const node of net.nodes.keys()) {
    if (cell >= cells.length) throw new Error('lattice too small for the net')
    placement.set(node, cell++)
  }
  // count wires (each undirected wire once) and how many connect adjacent cells
  let wires = 0
  let local = 0
  const seen = new Set<string>()
  for (const node of net.nodes.keys()) {
    for (let slot = 0; slot <= 2; slot++) {
      const peer = net.peer({ node, slot })
      if (!peer || !placement.has(peer.node)) continue
      const key = node < peer.node ? `${node}-${peer.node}` : `${peer.node}-${node}`
      if (seen.has(key)) continue
      seen.add(key)
      wires++
      if (adjacent(cells, placement.get(node)!, placement.get(peer.node)!)) local++
    }
  }
  return { placement, locality: wires === 0 ? 1 : local / wires }
}
