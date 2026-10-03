// k-nucleotide, the same generator, table and counts as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): a Dictionary of every k-mer per length, keyed by a Substring of the sequence
func sequence(_ n: Int) -> String {
    var seed = 42
    var dna = ""
    dna.reserveCapacity(n)

    for _ in 0..<n {
        seed = (seed * 3877 + 29573) % 139968
        let r = Double(seed) / 139968.0
        dna.append(r < 0.302954942668 ? "a" : r < 0.5009432431601 ? "c" : r < 0.6984905497992 ? "g" : "t")
    }

    return dna
}

func frequencies(_ dna: String, _ k: Int) -> [Substring: Int] {
    var counts: [Substring: Int] = [:]
    let bytes = dna.utf8
    var start = bytes.startIndex
    var count = 0

    while count + k <= bytes.count {
        let end = bytes.index(start, offsetBy: k)
        counts[dna[start..<end], default: 0] += 1
        start = bytes.index(after: start)
        count += 1
    }

    return counts
}

func summary(_ dna: String, _ k: Int) -> String {
    let counts = frequencies(dna, k)

    return "\(counts.count):\(counts.values.max() ?? 0)"
}

func occurrences(_ dna: String, _ part: String) -> Int {
    frequencies(dna, part.utf8.count)[Substring(part)] ?? 0
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 1000 : 1000
let dna = sequence(n)
let parts = ["ggt", "ggta", "ggtatt", "ggtattttaatt", "ggtattttaatttatagt"].map { String(occurrences(dna, $0)) }

print("\(summary(dna, 1)) \(summary(dna, 2)) \(parts.joined(separator: " "))")
