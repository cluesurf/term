// Graph, ours, the same structure as term.tree, written by hand as plain idiomatic Swift (2026-10-03): a grid's
// adjacency lists built fresh each run and searched breadth-first from the corner, the distances added
func neighbors(_ side: Int) -> [[Int]] {
    var cells: [[Int]] = []
    cells.reserveCapacity(side * side)

    for at in 0..<side * side {
        let row = at / side, column = at % side
        var near: [Int] = []

        if row > 0 { near.append(at - side) }
        if column > 0 { near.append(at - 1) }
        if column < side - 1 { near.append(at + 1) }
        if row < side - 1 { near.append(at + side) }

        cells.append(near)
    }

    return cells
}

func search(_ cells: [[Int]]) -> Int {
    var distance = [Int](repeating: -1, count: cells.count)
    var queue = [0]
    distance[0] = 0
    var total = 0
    var head = 0

    while head < queue.count {
        let at = queue[head]
        head += 1
        let here = distance[at]
        total += here

        for next in cells[at] where distance[next] == -1 {
            distance[next] = here + 1
            queue.append(next)
        }
    }

    return total
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1])! : 3
var total = 0

for _ in 0..<n {
    total += search(neighbors(40))
}

print(total)
