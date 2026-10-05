// mandelbrot, the same iteration as term.tree, written by hand as plain idiomatic Kotlin (ours, 2026-10-03): it counts
// the points in the set where the Benchmarks Game writes a bitmap
fun inside(cr: Double, ci: Double): Boolean {
    var zr = 0.0
    var zi = 0.0
    var tr = 0.0
    var ti = 0.0

    for (i in 0 until 50) {
        if (tr + ti > 4.0) break
        zi = 2.0 * zr * zi + ci
        zr = tr - ti + cr
        tr = zr * zr
        ti = zi * zi
    }

    return tr + ti <= 4.0
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 200
    val size = n.toDouble()
    var count = 0

    for (y in 0 until n) {
        val ci = 2.0 * y / size - 1.0

        for (x in 0 until n) {
            if (inside(2.0 * x / size - 1.5, ci)) count++
        }
    }

    println(count)
}
