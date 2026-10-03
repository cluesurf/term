// fannkuch-redux, single-threaded. Ours: a line-for-line transliteration of the Benchmarks Game's
// fannkuchredux.java-8.java (upstream/), "naive transliteration from Rex Kerr's Scala program", contributed by
// Isaac Gouy. Revised BSD, upstream/LICENSE. The Benchmarks Game's Kotlin entry is multi-threaded.

fun fannkuch(n: Int): Int {
    val perm1 = IntArray(n)
    for (i in 0 until n) perm1[i] = i
    val perm = IntArray(n)
    val count = IntArray(n)
    var f: Int
    var flips = 0
    var nperm = 0
    var checksum = 0
    var i: Int
    var k: Int
    var r: Int

    r = n
    while (r > 0) {
        i = 0
        while (r != 1) { count[r - 1] = r; r -= 1 }
        while (i < n) { perm[i] = perm1[i]; i += 1 }

        // Count flips and update max and checksum
        f = 0
        k = perm[0]
        while (k != 0) {
            i = 0
            while (2 * i < k) {
                val t = perm[i]; perm[i] = perm[k - i]; perm[k - i] = t
                i += 1
            }
            k = perm[0]
            f += 1
        }
        if (f > flips) flips = f
        if ((nperm and 0x1) == 0) checksum += f else checksum -= f

        // Use incremental change to generate another permutation
        var more = true
        while (more) {
            if (r == n) {
                println(checksum)
                return flips
            }
            val p0 = perm1[0]
            i = 0
            while (i < r) {
                val j = i + 1
                perm1[i] = perm1[j]
                i = j
            }
            perm1[r] = p0

            count[r] -= 1
            if (count[r] > 0) more = false else r += 1
        }
        nperm += 1
    }
    return flips
}

fun main(args: Array<String>) {
    val n = if (args.isNotEmpty()) args[0].toInt() else 7
    println("Pfannkuchen(" + n + ") = " + fannkuch(n))
}
