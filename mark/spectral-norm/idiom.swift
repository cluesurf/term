// spectral-norm, the same algorithm as term.tree, written by hand as plain idiomatic Swift (ours, 2026-10-02)
@inline(__always) func a(_ i: Int, _ j: Int) -> Double {
    let ij = i + j
    let index = ij * (ij + 1) / 2 + i + 1
    return 1.0 / Double(index)
}

func timesA(_ v: [Double], _ out: inout [Double]) {
    for i in 0..<out.count {
        var sum = 0.0
        for j in 0..<v.count { sum += a(i, j) * v[j] }
        out[i] = sum
    }
}

func timesAt(_ v: [Double], _ out: inout [Double]) {
    for i in 0..<out.count {
        var sum = 0.0
        for j in 0..<v.count { sum += a(j, i) * v[j] }
        out[i] = sum
    }
}

func timesAtA(_ v: [Double], _ out: inout [Double], _ between: inout [Double]) {
    timesA(v, &between)
    timesAt(between, &out)
}

let n = CommandLine.arguments.count > 1 ? Int(CommandLine.arguments[1]) ?? 100 : 100
var u = [Double](repeating: 1.0, count: n)
var v = [Double](repeating: 0.0, count: n)
var between = [Double](repeating: 0.0, count: n)

for _ in 0..<10 {
    timesAtA(u, &v, &between)
    timesAtA(v, &u, &between)
}

var vbv = 0.0
var vv = 0.0

for i in 0..<n {
    vbv += u[i] * v[i]
    vv += v[i] * v[i]
}

print(Int(((vbv / vv).squareRoot() * 1_000_000_000.0).rounded(.down)))
