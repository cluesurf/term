// spectral-norm, the same algorithm as term.tree, written by hand as plain idiomatic TypeScript (ours, 2026-10-02)
const a = (i: number, j: number): number => 1 / (((i + j) * (i + j + 1)) / 2 + i + 1)

function timesA(v: Float64Array, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let j = 0; j < v.length; j++) sum += a(i, j) * v[j]!
    out[i] = sum
  }
}

function timesAt(v: Float64Array, out: Float64Array): void {
  for (let i = 0; i < out.length; i++) {
    let sum = 0
    for (let j = 0; j < v.length; j++) sum += a(j, i) * v[j]!
    out[i] = sum
  }
}

function timesAtA(v: Float64Array, out: Float64Array, between: Float64Array): void {
  timesA(v, between)
  timesAt(between, out)
}

const n = Number(process.argv[2] ?? 100)
const u = new Float64Array(n).fill(1)
const v = new Float64Array(n)
const between = new Float64Array(n)

for (let round = 0; round < 10; round++) {
  timesAtA(u, v, between)
  timesAtA(v, u, between)
}

let vbv = 0
let vv = 0

for (let i = 0; i < n; i++) {
  vbv += u[i]! * v[i]!
  vv += v[i]! * v[i]!
}

console.log(Math.floor(Math.sqrt(vbv / vv) * 1_000_000_000))
