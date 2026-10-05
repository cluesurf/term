// fannkuch-redux, the same algorithm as term.tree, written by hand as plain idiomatic TypeScript (ours, 2026-10-02)
function fannkuch(n: number): [number, number] {
  const perm1 = Array.from({ length: n }, (_, i) => i)
  const count = new Array<number>(n).fill(0)
  const perm = new Array<number>(n).fill(0)
  let maxFlips = 0
  let checksum = 0
  let permCount = 0
  let r = n

  for (;;) {
    while (r !== 1) {
      count[r - 1] = r
      r--
    }
    for (let i = 0; i < n; i++) perm[i] = perm1[i]!
    let flips = 0
    let k = perm[0]!
    while (k !== 0) {
      for (let low = 0, high = k; low < high; low++, high--) {
        const t = perm[low]!
        perm[low] = perm[high]!
        perm[high] = t
      }
      flips++
      k = perm[0]!
    }
    if (flips > maxFlips) maxFlips = flips
    checksum += permCount % 2 === 0 ? flips : -flips
    for (;;) {
      if (r === n) return [checksum, maxFlips]
      const perm0 = perm1[0]!
      for (let i = 0; i < r; i++) perm1[i] = perm1[i + 1]!
      perm1[r] = perm0
      count[r]!--
      if (count[r]! > 0) break
      r++
    }
    permCount++
  }
}

const n = Number(process.argv[2] ?? 7)
const [checksum, maxFlips] = fannkuch(n)
console.log(`${checksum}\nPfannkuchen(${n}) = ${maxFlips}`)
