// Sieve, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): an array of flags made full, each prime's multiples cleared, the count run `n` times and added
func countPrimes(_ flags: inout [Bool], _ size: Int) -> Int {
    var primes = 0

    for i in 2...size where flags[i - 1] {
        primes += 1

        for k in stride(from: i + i, through: size, by: i) {
            flags[k - 1] = false
        }
    }

    return primes
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 3 : 3
var total = 0

for _ in 0..<n {
    var flags = [Bool](repeating: true, count: 5000)
    total += countPrimes(&flags, 5000)
}

print(total)
