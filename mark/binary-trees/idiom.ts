// binary-trees, the same algorithm as term.tree, written by hand as plain idiomatic TypeScript (ours, 2026-10-02): a
// node per allocation, as the Benchmarks Game requires
type Tree = { left: Tree; right: Tree } | null

function bottomUp(depth: number): Tree {
  return depth > 0 ? { left: bottomUp(depth - 1), right: bottomUp(depth - 1) } : null
}

function itemCheck(tree: Tree): number {
  return tree === null ? 1 : 1 + itemCheck(tree.left) + itemCheck(tree.right)
}

const n = Number(process.argv[2] ?? 10)
const maxDepth = Math.max(6, n)
const stretchDepth = maxDepth + 1
const lines = [`stretch tree of depth ${stretchDepth}\t check: ${itemCheck(bottomUp(stretchDepth))}`]
const longLived = bottomUp(maxDepth)

for (let depth = 4; depth <= maxDepth; depth += 2) {
  const iterations = 2 ** (maxDepth - depth + 4)
  let check = 0
  for (let i = 0; i < iterations; i++) check += itemCheck(bottomUp(depth))
  lines.push(`${iterations}\t trees of depth ${depth}\t check: ${check}`)
}

lines.push(`long lived tree of depth ${maxDepth}\t check: ${itemCheck(longLived)}`)
console.log(lines.join('\n'))
