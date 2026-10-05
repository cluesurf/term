// Permute, from Are We Fast Yet, written by hand as plain idiomatic Swift (ours, 2026-10-03): AWFY's own shape, a
// benchmark struct holding the counter and the six items, `permute` recursive and `swap` in place
struct Permute {
    var count = 0
    var v = [Int](repeating: 0, count: 6)

    mutating func permute(_ n: Int) {
        count += 1

        if n != 0 {
            let n1 = n - 1
            permute(n1)

            for i in stride(from: n1, through: 0, by: -1) {
                v.swapAt(n1, i)
                permute(n1)
                v.swapAt(n1, i)
            }
        }
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 2 : 2
var total = 0

for _ in 0..<n {
    var run = Permute()
    run.permute(6)
    total += run.count
}

print(total)
