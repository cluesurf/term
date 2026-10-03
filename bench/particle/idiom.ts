// Particle, ours, the same structure as term.tree, written by hand as plain idiomatic TypeScript (2026-10-03): 100
// records each holding 8 coordinates, every coordinate rewritten in place for 50 steps, then all added
interface Particle {
  id: number
  xs: number[]
}

function makeParticle(k: number): Particle {
  const xs: number[] = []

  for (let i = 0; i < 8; i++) {
    xs.push((k * 7 + i) % 1000)
  }

  return { id: k, xs }
}

const n = Number(process.argv[2] ?? 3)
let total = 0

for (let round = 0; round < n; round++) {
  const ps: Particle[] = []

  for (let k = 0; k < 100; k++) {
    ps.push(makeParticle(k))
  }

  for (let step = 0; step < 50; step++) {
    for (const p of ps) {
      for (let i = 0; i < 8; i++) {
        p.xs[i] = (p.xs[i]! * 31 + i + step) % 1000
      }
    }
  }

  for (const p of ps) {
    for (const x of p.xs) {
      total += x
    }
  }
}

console.log(total)
