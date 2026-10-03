// Storage, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): a tree of arrays seven levels deep built by recursion, AWFY's generator sizing each leaf, the arrays
// counted and every leaf's length read back, run `n` times and added
indirect enum Tree {
    case leaf([Int])
    case node([Tree])
}

struct Random {
    var seed = 74755

    mutating func next() -> Int {
        seed = (seed * 1309 + 13849) & 65535
        return seed
    }
}

func build(_ depth: Int, _ random: inout Random, _ count: inout Int) -> Tree {
    count += 1

    if depth == 1 {
        return .leaf([Int](repeating: 0, count: random.next() % 10 + 1))
    }

    var kids: [Tree] = []
    kids.reserveCapacity(4)

    for _ in 0..<4 {
        kids.append(build(depth - 1, &random, &count))
    }

    return .node(kids)
}

func leaves(_ tree: Tree) -> Int {
    switch tree {
    case .leaf(let items):
        return items.count
    case .node(let kids):
        return kids.reduce(0) { $0 + leaves($1) }
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1])! : 3
var total = 0

for _ in 0..<n {
    var random = Random()
    var count = 0
    let tree = build(7, &random, &count)
    total += count + leaves(tree)
}

print(total)
