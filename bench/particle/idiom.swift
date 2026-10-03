// Particle, ours, the same structure as term.tree, written by hand as plain idiomatic Swift (2026-10-03): 100 structs
// each holding 8 coordinates, every coordinate rewritten in place for 50 steps, then all added
struct Particle {
    let id: Int
    var xs: [Int]
}

func makeParticle(_ k: Int) -> Particle {
    Particle(id: k, xs: (0..<8).map { (k * 7 + $0) % 1000 })
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1])! : 3
var total = 0

for _ in 0..<n {
    var ps = (0..<100).map(makeParticle)

    for step in 0..<50 {
        for k in ps.indices {
            for i in 0..<8 {
                ps[k].xs[i] = (ps[k].xs[i] * 31 + i + step) % 1000
            }
        }
    }

    for p in ps {
        total += p.xs.reduce(0, +)
    }
}

print(total)
