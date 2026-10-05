// k-nucleotide, the same generator, table and counts as term.tree, written by hand as plain idiomatic TypeScript (ours,
// 2026-10-03): a Map of every k-mer per length, keyed by the substring
function sequence(n: number): string {
  let seed = 42
  let dna = ''

  for (let i = 0; i < n; i++) {
    seed = (seed * 3877 + 29573) % 139968
    const r = seed / 139968.0
    dna += r < 0.302954942668 ? 'a' : r < 0.5009432431601 ? 'c' : r < 0.6984905497992 ? 'g' : 't'
  }

  return dna
}

function frequencies(dna: string, k: number): Map<string, number> {
  const counts = new Map<string, number>()

  for (let i = 0; i + k <= dna.length; i++) {
    const key = dna.substring(i, i + k)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return counts
}

function summary(dna: string, k: number): string {
  const counts = frequencies(dna, k)

  return `${counts.size}:${Math.max(0, ...counts.values())}`
}

const occurrences = (dna: string, part: string): number => frequencies(dna, part.length).get(part) ?? 0

const n = Number(process.argv[2] ?? 1000)
const dna = sequence(n)
const parts = ['ggt', 'ggta', 'ggtatt', 'ggtattttaatt', 'ggtattttaatttatagt'].map(p => occurrences(dna, p))

console.log(`${summary(dna, 1)} ${summary(dna, 2)} ${parts.join(' ')}`)
