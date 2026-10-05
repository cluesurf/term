// Storage, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic TypeScript (ours,
// 2026-10-03): a tree of arrays seven levels deep built by recursion, AWFY's generator sizing each leaf, the arrays
// counted and every leaf's length read back, run `n` times and added
type Tree = number[] | Tree[]

let seed = 74755
let count = 0

function nextRandom(): number {
  seed = (seed * 1309 + 13849) & 65535
  return seed
}

function build(depth: number): Tree {
  count++

  if (depth === 1) {
    return new Array<number>((nextRandom() % 10) + 1).fill(0)
  }

  const kids: Tree[] = new Array(4)

  for (let i = 0; i < 4; i++) {
    kids[i] = build(depth - 1)
  }

  return kids
}

function leaves(tree: Tree, depth: number): number {
  if (depth === 1) {
    return tree.length
  }

  let total = 0

  for (const kid of tree as Tree[]) {
    total += leaves(kid, depth - 1)
  }

  return total
}

const n = Number(process.argv[2] ?? 3)
let total = 0

for (let round = 0; round < n; round++) {
  seed = 74755
  count = 0
  const tree = build(7)
  total += count + leaves(tree, 7)
}

console.log(total)
