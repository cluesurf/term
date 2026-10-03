// Sieve, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic TypeScript (ours,
// 2026-10-03): an array of flags made full, each prime's multiples cleared, the count run `n` times and added
function countPrimes(flags: boolean[], size: number): number {
  let primes = 0

  for (let i = 2; i <= size; i++) {
    if (flags[i - 1]) {
      primes++

      for (let k = i + i; k <= size; k += i) {
        flags[k - 1] = false
      }
    }
  }

  return primes
}

const n = Number(process.argv[2] ?? 3)
let total = 0

for (let round = 0; round < n; round++) {
  total += countPrimes(new Array<boolean>(5000).fill(true), 5000)
}

console.log(total)
