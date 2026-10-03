// Permute, from Are We Fast Yet, written by hand as plain idiomatic TypeScript (ours, 2026-10-03): AWFY's own shape,
// a benchmark object holding the counter and the six items, `permute` recursive and `swap` in place
class Permute {
  count = 0
  v = new Array<number>(6).fill(0)

  permute(n: number): void {
    this.count++

    if (n !== 0) {
      const n1 = n - 1
      this.permute(n1)

      for (let i = n1; i >= 0; i--) {
        this.swap(n1, i)
        this.permute(n1)
        this.swap(n1, i)
      }
    }
  }

  swap(i: number, j: number): void {
    const t = this.v[i]!
    this.v[i] = this.v[j]!
    this.v[j] = t
  }
}

const n = Number(process.argv[2] ?? 2)
let total = 0

for (let round = 0; round < n; round++) {
  const run = new Permute()
  run.permute(6)
  total += run.count
}

console.log(total)
