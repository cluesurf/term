// fasta, the same generator, tables and line building as term.tree, written by hand as plain idiomatic TypeScript
// (ours, 2026-10-03): every character the Benchmarks Game would print, newlines too, folded into a hash, then the count
// and the hash printed
const ALU =
  'GGCCGGGCGCGGTGGCTCACGCCTGTAATCCCAGCACTTTGGGAGGCCGAGGCGGGCGGATCACCTGAGGTCAGGAGTTCGAGACCAGCCTGGCCAACATGGTGAAACCCCGTCTCTACTAAAAATACAAAAATTAGCCGGGCGTGGTGGCGCGCGCCTGTAATCCCAGCTACTCGGGAGGCTGAGGCAGGAGAATCGCTTGAACCCGGGAGGCGGAGGTTGCAGTGAGCCGAGATCGCGCCACTGCACTCCAGCCTGGGCGACAGAGCGAGACTCCGTCTCAAAAA'
const MOD = 1_000_000_007
const state = { seed: 42, hash: 0, count: 0 }

function fold(line: string): void {
  let hash = state.hash

  for (let i = 0; i < line.length; i++) hash = (hash * 31 + line.charCodeAt(i)) % MOD

  state.hash = (hash * 31 + 10) % MOD
  state.count += line.length + 1
}

function repeated(total: number): void {
  let line = ''

  for (let i = 0; i < total; i++) {
    line += ALU[i % ALU.length]

    if (line.length === 60) {
      fold(line)
      line = ''
    }
  }

  if (line.length > 0) fold(line)
}

function random(letters: string, cumulative: number[], total: number): void {
  let line = ''

  for (let i = 0; i < total; i++) {
    state.seed = (state.seed * 3877 + 29573) % 139968
    const r = state.seed / 139968
    let pick = 0

    while (pick < letters.length - 1 && r >= cumulative[pick]!) pick++

    line += letters[pick]

    if (line.length === 60) {
      fold(line)
      line = ''
    }
  }

  if (line.length > 0) fold(line)
}

function accumulate(probabilities: number[]): number[] {
  let sum = 0

  return probabilities.map(p => (sum += p))
}

const n = Number(process.argv[2] ?? 1000)
const iub = accumulate([0.27, 0.12, 0.12, 0.27, ...new Array<number>(11).fill(0.02)])
const homo = accumulate([0.302954942668, 0.1979883004921, 0.1975473066391, 0.3015094502008])

repeated(n * 2)
random('acgtBDHKMNRSVWY', iub, n * 3)
random('acgt', homo, n * 5)
console.log(`${state.count} ${state.hash}`)
