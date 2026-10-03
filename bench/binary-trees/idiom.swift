// binary-trees, the same algorithm as term.tree, written by hand as plain idiomatic Swift (ours, 2026-10-02): a node per
// allocation, as the Benchmarks Game requires
indirect enum Tree {
    case leaf
    case branch(Tree, Tree)
}

func bottomUp(_ depth: Int) -> Tree {
    depth > 0 ? .branch(bottomUp(depth - 1), bottomUp(depth - 1)) : .leaf
}

func itemCheck(_ tree: Tree) -> Int {
    switch tree {
    case .leaf: return 1
    case let .branch(left, right): return 1 + itemCheck(left) + itemCheck(right)
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 10 : 10
let maxDepth = max(6, n)
let stretchDepth = maxDepth + 1
var lines = ["stretch tree of depth \(stretchDepth)\t check: \(itemCheck(bottomUp(stretchDepth)))"]
let longLived = bottomUp(maxDepth)
var depth = 4
while depth <= maxDepth {
    let iterations = 1 << (maxDepth - depth + 4)
    var check = 0
    for _ in 0..<iterations { check += itemCheck(bottomUp(depth)) }
    lines.append("\(iterations)\t trees of depth \(depth)\t check: \(check)")
    depth += 2
}
lines.append("long lived tree of depth \(maxDepth)\t check: \(itemCheck(longLived))")
print(lines.joined(separator: "\n"))
