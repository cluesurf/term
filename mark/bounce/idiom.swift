// Bounce, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Swift (ours,
// 2026-10-03): AWFY's own shape, a generator and an array of ball structs whose fields `bounce` changes in place
struct Random {
    var seed = 74755

    mutating func next() -> Int {
        seed = (seed * 1309 + 13849) & 65535
        return seed
    }
}

struct Ball {
    var x: Int
    var y: Int
    var dx: Int
    var dy: Int

    init(_ random: inout Random) {
        x = random.next() % 500
        y = random.next() % 500
        dx = random.next() % 300 - 150
        dy = random.next() % 300 - 150
    }

    mutating func bounce() -> Bool {
        var bounced = false
        x += dx
        y += dy

        if x > 500 {
            x = 500
            dx = -abs(dx)
            bounced = true
        }

        if x < 0 {
            x = 0
            dx = abs(dx)
            bounced = true
        }

        if y > 500 {
            y = 500
            dy = -abs(dy)
            bounced = true
        }

        if y < 0 {
            y = 0
            dy = abs(dy)
            bounced = true
        }

        return bounced
    }
}

func run() -> Int {
    var random = Random()
    var balls: [Ball] = []

    for _ in 0..<100 {
        balls.append(Ball(&random))
    }

    var bounces = 0

    for _ in 0..<50 {
        for i in balls.indices where balls[i].bounce() {
            bounces += 1
        }
    }

    return bounces
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 2 : 2
var total = 0

for _ in 0..<n {
    total += run()
}

print(total)
