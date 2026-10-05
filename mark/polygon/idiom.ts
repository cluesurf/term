// Polygon, ours, the same structure as term.tree, written by hand as plain idiomatic TypeScript (2026-10-03): 200
// polygons a run, each a record holding its corners' coordinates, built fresh and then measured, the taxicab
// perimeters added
interface Polygon {
  sides: number
  points: number[]
}

function makePolygon(k: number): Polygon {
  const sides = 3 + (k % 13)
  const points: number[] = []
  let x = k % 17
  let y = (k * 7) % 23

  for (let c = 0; c < sides; c++) {
    points.push(x, y)
    x = (x + c + k) % 50
    y = (y + c * 3) % 50
  }

  return { sides, points }
}

function perimeter(p: Polygon): number {
  let total = 0

  for (let c = 0; c < p.sides; c++) {
    const next = (c + 1) % p.sides
    total += Math.abs(p.points[c * 2]! - p.points[next * 2]!) + Math.abs(p.points[c * 2 + 1]! - p.points[next * 2 + 1]!)
  }

  return total
}

const n = Number(process.argv[2] ?? 3)
let total = 0

for (let round = 0; round < n; round++) {
  const shapes: Polygon[] = []

  for (let k = 0; k < 200; k++) {
    shapes.push(makePolygon(k))
  }

  for (const p of shapes) {
    total += perimeter(p)
  }
}

console.log(total)
