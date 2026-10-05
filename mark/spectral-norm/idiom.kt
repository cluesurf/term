// spectral-norm, the same algorithm as term.tree, written by hand as plain idiomatic Kotlin (ours, 2026-10-02)
fun a(i: Int, j: Int): Double = 1.0 / ((i + j) * (i + j + 1) / 2 + i + 1).toDouble()

fun timesA(v: DoubleArray, out: DoubleArray) {
    for (i in out.indices) {
        var sum = 0.0
        for (j in v.indices) sum += a(i, j) * v[j]
        out[i] = sum
    }
}

fun timesAt(v: DoubleArray, out: DoubleArray) {
    for (i in out.indices) {
        var sum = 0.0
        for (j in v.indices) sum += a(j, i) * v[j]
        out[i] = sum
    }
}

fun timesAtA(v: DoubleArray, out: DoubleArray, between: DoubleArray) {
    timesA(v, between)
    timesAt(between, out)
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 100
    val u = DoubleArray(n) { 1.0 }
    val v = DoubleArray(n)
    val between = DoubleArray(n)

    repeat(10) {
        timesAtA(u, v, between)
        timesAtA(v, u, between)
    }

    var vbv = 0.0
    var vv = 0.0

    for (i in 0 until n) {
        vbv += u[i] * v[i]
        vv += v[i] * v[i]
    }

    println(Math.floor(Math.sqrt(vbv / vv) * 1_000_000_000.0).toLong())
}
