// Polygon, ours, the same structure as term.tree, written by hand as plain idiomatic Swift (2026-10-03): 200 polygons a
// run, each a struct holding its corners' coordinates, built fresh and then measured, the taxicab perimeters added
struct Polygon {
    let sides: Int
    let points: [Int]
}

func makePolygon(_ k: Int) -> Polygon {
    let sides = 3 + k % 13
    var points: [Int] = []
    var x = k % 17
    var y = (k * 7) % 23

    for c in 0..<sides {
        points.append(x)
        points.append(y)
        x = (x + c + k) % 50
        y = (y + c * 3) % 50
    }

    return Polygon(sides: sides, points: points)
}

func perimeter(_ p: Polygon) -> Int {
    var total = 0

    for c in 0..<p.sides {
        let next = (c + 1) % p.sides
        total += abs(p.points[c * 2] - p.points[next * 2]) + abs(p.points[c * 2 + 1] - p.points[next * 2 + 1])
    }

    return total
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1])! : 3
var total = 0

for _ in 0..<n {
    let shapes = (0..<200).map(makePolygon)

    for p in shapes {
        total += perimeter(p)
    }
}

print(total)
