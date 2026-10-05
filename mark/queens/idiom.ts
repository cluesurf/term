// Queens, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic TypeScript (ours,
// 2026-10-03): the board in one object's arrays, placement by backtracking, a checksum of each placement added
class Queens {
  rows = new Array<boolean>(8).fill(true)
  maxs = new Array<boolean>(16).fill(true)
  mins = new Array<boolean>(16).fill(true)
  queens = new Array<number>(8).fill(-1)

  isFree(r: number, c: number): boolean {
    return this.rows[r]! && this.maxs[c + r]! && this.mins[c - r + 7]!
  }

  mark(r: number, c: number, free: boolean): void {
    this.rows[r] = free
    this.maxs[c + r] = free
    this.mins[c - r + 7] = free
  }

  place(c: number): boolean {
    for (let r = 0; r < 8; r++) {
      if (this.isFree(r, c)) {
        this.queens[r] = c
        this.mark(r, c, false)

        if (c === 7 || this.place(c + 1)) {
          return true
        }

        this.mark(r, c, true)
      }
    }

    return false
  }

  solve(): number {
    return this.place(0) ? this.queens.reduce((sum, q, r) => sum + (r + 1) * q, 0) : 0
  }
}

const n = Number(process.argv[2] ?? 10)
let total = 0

for (let round = 0; round < n; round++) {
  total += new Queens().solve()
}

console.log(total)
