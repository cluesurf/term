// fannkuch-redux, the same algorithm as term.tree, written by hand as plain idiomatic Swift (ours, 2026-10-02)
func fannkuch(_ n: Int) -> (Int, Int) {
    var perm1 = Array(0..<n)
    var count = [Int](repeating: 0, count: n)
    var perm = [Int](repeating: 0, count: n)
    var maxFlips = 0, checksum = 0, permCount = 0
    var r = n
    while true {
        while r != 1 {
            count[r - 1] = r
            r -= 1
        }
        for i in 0..<n { perm[i] = perm1[i] }
        var flips = 0
        var k = perm[0]
        while k != 0 {
            var low = 0, high = k
            while low < high {
                perm.swapAt(low, high)
                low += 1
                high -= 1
            }
            flips += 1
            k = perm[0]
        }
        maxFlips = max(maxFlips, flips)
        checksum += permCount % 2 == 0 ? flips : -flips
        while true {
            if r == n { return (checksum, maxFlips) }
            let perm0 = perm1[0]
            for i in 0..<r { perm1[i] = perm1[i + 1] }
            perm1[r] = perm0
            count[r] -= 1
            if count[r] > 0 { break }
            r += 1
        }
        permCount += 1
    }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 7 : 7
let (checksum, maxFlips) = fannkuch(n)
print("\(checksum)\nPfannkuchen(\(n)) = \(maxFlips)")
