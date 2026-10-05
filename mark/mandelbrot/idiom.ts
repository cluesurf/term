// mandelbrot, the same iteration as term.tree, written by hand as plain idiomatic TypeScript (ours, 2026-10-03): it
// counts the points in the set where the Benchmarks Game writes a bitmap
function inside(cr: number, ci: number): boolean {
  let zr = 0
  let zi = 0
  let tr = 0
  let ti = 0

  for (let i = 0; i < 50; i++) {
    if (tr + ti > 4) break
    zi = 2 * zr * zi + ci
    zr = tr - ti + cr
    tr = zr * zr
    ti = zi * zi
  }

  return tr + ti <= 4
}

const n = Number(process.argv[2] ?? 200)
let count = 0

for (let y = 0; y < n; y++) {
  const ci = (2 * y) / n - 1

  for (let x = 0; x < n; x++) {
    if (inside((2 * x) / n - 1.5, ci)) count++
  }
}

console.log(count)
