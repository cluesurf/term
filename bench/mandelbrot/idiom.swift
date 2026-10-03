// mandelbrot, the same iteration as term.tree, written by hand as plain idiomatic Swift (ours, 2026-10-03): it counts
// the points in the set where the Benchmarks Game writes a bitmap
@inline(__always) func inside(_ cr: Double, _ ci: Double) -> Bool {
    var zr = 0.0, zi = 0.0, tr = 0.0, ti = 0.0

    for _ in 0..<50 {
        if tr + ti > 4.0 { break }
        zi = 2.0 * zr * zi + ci
        zr = tr - ti + cr
        tr = zr * zr
        ti = zi * zi
    }

    return tr + ti <= 4.0
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 200 : 200
let size = Double(n)
var count = 0

for y in 0..<n {
    let ci = 2.0 * Double(y) / size - 1.0

    for x in 0..<n where inside(2.0 * Double(x) / size - 1.5, ci) {
        count += 1
    }
}

print(count)
