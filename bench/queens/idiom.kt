// Queens, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): the board in one class's arrays, placement by backtracking, a checksum of each placement added
class Queens {
    private val rows = BooleanArray(8) { true }
    private val maxs = BooleanArray(16) { true }
    private val mins = BooleanArray(16) { true }
    private val queens = IntArray(8) { -1 }

    private fun isFree(r: Int, c: Int): Boolean = rows[r] && maxs[c + r] && mins[c - r + 7]

    private fun mark(r: Int, c: Int, free: Boolean) {
        rows[r] = free
        maxs[c + r] = free
        mins[c - r + 7] = free
    }

    private fun place(c: Int): Boolean {
        for (r in 0 until 8) {
            if (isFree(r, c)) {
                queens[r] = c
                mark(r, c, false)

                if (c == 7 || place(c + 1)) return true

                mark(r, c, true)
            }
        }

        return false
    }

    fun solve(): Long = if (place(0)) queens.withIndex().sumOf { (r, q) -> (r + 1L) * q } else 0L
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 10
    var total = 0L

    repeat(n) { total += Queens().solve() }

    println(total)
}
