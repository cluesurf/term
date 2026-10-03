// Permute, from Are We Fast Yet, written by hand as plain idiomatic Kotlin (ours, 2026-10-03): AWFY's own shape, a
// benchmark object holding the counter and the six items, `permute` recursive and `swap` in place
class Permute {
    var count = 0L
    private val v = LongArray(6)

    fun permute(n: Int) {
        count++

        if (n != 0) {
            val n1 = n - 1
            permute(n1)

            for (i in n1 downTo 0) {
                swap(n1, i)
                permute(n1)
                swap(n1, i)
            }
        }
    }

    private fun swap(i: Int, j: Int) {
        val t = v[i]
        v[i] = v[j]
        v[j] = t
    }
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 2
    var total = 0L

    repeat(n) {
        val run = Permute()
        run.permute(6)
        total += run.count
    }

    println(total)
}
