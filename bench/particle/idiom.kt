// Particle, ours, the same structure as term.tree, written by hand as plain idiomatic Kotlin (2026-10-03): 100 objects
// each holding 8 coordinates, every coordinate rewritten in place for 50 steps, then all added
class Particle(val id: Int, val xs: LongArray)

fun makeParticle(k: Int): Particle = Particle(k, LongArray(8) { ((k * 7 + it) % 1000).toLong() })

fun main(args: Array<String>) {
    val n = args.getOrNull(0)?.toInt() ?: 3
    var total = 0L

    repeat(n) {
        val ps = List(100) { makeParticle(it) }

        for (step in 0 until 50) {
            for (p in ps) {
                for (i in 0 until 8) {
                    p.xs[i] = (p.xs[i] * 31 + i + step) % 1000
                }
            }
        }

        for (p in ps) {
            total += p.xs.sum()
        }
    }

    println(total)
}
