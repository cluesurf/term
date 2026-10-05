// Queens, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): the board in one struct's arrays, placement by backtracking, a checksum of each placement added
struct Queens {
    var rows = [Bool](repeating: true, count: 8)
    var maxs = [Bool](repeating: true, count: 16)
    var mins = [Bool](repeating: true, count: 16)
    var queens = [Int](repeating: -1, count: 8)

    func isFree(_ r: Int, _ c: Int) -> Bool {
        rows[r] && maxs[c + r] && mins[c - r + 7]
    }

    mutating func mark(_ r: Int, _ c: Int, _ free: Bool) {
        rows[r] = free
        maxs[c + r] = free
        mins[c - r + 7] = free
    }

    mutating func place(_ c: Int) -> Bool {
        for r in 0..<8 where isFree(r, c) {
            queens[r] = c
            mark(r, c, false)

            if c == 7 || place(c + 1) {
                return true
            }

            mark(r, c, true)
        }

        return false
    }

    mutating func solve() -> Int {
        place(0) ? queens.enumerated().reduce(0) { $0 + ($1.offset + 1) * $1.element } : 0
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 10 : 10
var total = 0

for _ in 0..<n {
    var board = Queens()
    total += board.solve()
}

print(total)
