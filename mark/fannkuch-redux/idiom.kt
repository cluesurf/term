// fannkuch-redux, the same algorithm as term.tree, written by hand as plain idiomatic Kotlin (ours, 2026-10-02)
fun fannkuch(n: Int): Pair<Long, Long> {
    val perm1 = IntArray(n) { it }
    val count = IntArray(n)
    val perm = IntArray(n)
    var maxFlips = 0L
    var checksum = 0L
    var permCount = 0L
    var r = n
    while (true) {
        while (r != 1) {
            count[r - 1] = r
            r--
        }
        perm1.copyInto(perm)
        var flips = 0L
        var k = perm[0]
        while (k != 0) {
            var low = 0
            var high = k
            while (low < high) {
                val t = perm[low]
                perm[low] = perm[high]
                perm[high] = t
                low++
                high--
            }
            flips++
            k = perm[0]
        }
        if (flips > maxFlips) maxFlips = flips
        checksum += if (permCount % 2 == 0L) flips else -flips
        while (true) {
            if (r == n) return Pair(checksum, maxFlips)
            val perm0 = perm1[0]
            for (i in 0 until r) perm1[i] = perm1[i + 1]
            perm1[r] = perm0
            count[r]--
            if (count[r] > 0) break
            r++
        }
        permCount++
    }
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 7
    val (checksum, maxFlips) = fannkuch(n)
    println("$checksum\nPfannkuchen($n) = $maxFlips")
}
