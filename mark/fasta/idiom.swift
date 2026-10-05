// fasta, the same generator, tables and line building as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): every character the Benchmarks Game would print, newlines too, folded into a hash, then the count and
// the hash printed
let alu = Array("GGCCGGGCGCGGTGGCTCACGCCTGTAATCCCAGCACTTTGGGAGGCCGAGGCGGGCGGATCACCTGAGGTCAGGAGTTCGAGACCAGCCTGGCCAACATGGTGAAACCCCGTCTCTACTAAAAATACAAAAATTAGCCGGGCGTGGTGGCGCGCGCCTGTAATCCCAGCTACTCGGGAGGCTGAGGCAGGAGAATCGCTTGAACCCGGGAGGCGGAGGTTGCAGTGAGCCGAGATCGCGCCACTGCACTCCAGCCTGGGCGACAGAGCGAGACTCCGTCTCAAAAA".utf8)
let modulus = 1_000_000_007

struct State {
    var seed = 42
    var hash = 0
    var count = 0

    mutating func fold(_ line: String) {
        for b in line.utf8 {
            hash = (hash * 31 + Int(b)) % modulus
        }

        hash = (hash * 31 + 10) % modulus
        count += line.utf8.count + 1
    }

    mutating func repeated(_ total: Int) {
        var line = ""
        var width = 0

        for i in 0..<total {
            line.append(Character(Unicode.Scalar(alu[i % alu.count])))
            width += 1

            if width == 60 {
                fold(line)
                line = ""
                width = 0
            }
        }

        if width > 0 { fold(line) }
    }

    mutating func random(_ letters: [UInt8], _ cumulative: [Double], _ total: Int) {
        var line = ""
        var width = 0

        for _ in 0..<total {
            seed = (seed * 3877 + 29573) % 139968
            let r = Double(seed) / 139968.0
            var pick = 0

            while pick < letters.count - 1 && r >= cumulative[pick] { pick += 1 }

            line.append(Character(Unicode.Scalar(letters[pick])))
            width += 1

            if width == 60 {
                fold(line)
                line = ""
                width = 0
            }
        }

        if width > 0 { fold(line) }
    }
}

func accumulate(_ probabilities: [Double]) -> [Double] {
    var sum = 0.0

    return probabilities.map { sum += $0; return sum }
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 1000 : 1000
let iub = accumulate([0.27, 0.12, 0.12, 0.27] + [Double](repeating: 0.02, count: 11))
let homo = accumulate([0.3029549426680, 0.1979883004921, 0.1975473066391, 0.3015094502008])
var at = State()

at.repeated(n * 2)
at.random(Array("acgtBDHKMNRSVWY".utf8), iub, n * 3)
at.random(Array("acgt".utf8), homo, n * 5)
print("\(at.count) \(at.hash)")
