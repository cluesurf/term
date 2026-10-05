// fasta, the same generator, tables and line building as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): every character the Benchmarks Game would print, newlines too, folded into a hash, then the count and
// the hash printed
const val ALU =
    "GGCCGGGCGCGGTGGCTCACGCCTGTAATCCCAGCACTTTGGGAGGCCGAGGCGGGCGGATCACCTGAGGTCAGGAGTTCGAGACCAGCCTGGCCAACATGGTGAAACCCCGTCTCTACTAAAAATACAAAAATTAGCCGGGCGTGGTGGCGCGCGCCTGTAATCCCAGCTACTCGGGAGGCTGAGGCAGGAGAATCGCTTGAACCCGGGAGGCGGAGGTTGCAGTGAGCCGAGATCGCGCCACTGCACTCCAGCCTGGGCGACAGAGCGAGACTCCGTCTCAAAAA"
const val MOD = 1_000_000_007L

class State {
    var seed = 42L
    var hash = 0L
    var count = 0L

    fun fold(line: CharSequence) {
        for (c in line) hash = (hash * 31 + c.code) % MOD
        hash = (hash * 31 + 10) % MOD
        count += line.length + 1
    }

    fun repeated(total: Int) {
        val line = StringBuilder(60)

        for (i in 0 until total) {
            line.append(ALU[i % ALU.length])

            if (line.length == 60) {
                fold(line)
                line.setLength(0)
            }
        }

        if (line.isNotEmpty()) fold(line)
    }

    fun random(letters: String, cumulative: DoubleArray, total: Int) {
        val line = StringBuilder(60)

        repeat(total) {
            seed = (seed * 3877 + 29573) % 139968
            val r = seed / 139968.0
            var pick = 0

            while (pick < letters.length - 1 && r >= cumulative[pick]) pick++

            line.append(letters[pick])

            if (line.length == 60) {
                fold(line)
                line.setLength(0)
            }
        }

        if (line.isNotEmpty()) fold(line)
    }
}

fun accumulate(probabilities: DoubleArray): DoubleArray {
    var sum = 0.0

    return DoubleArray(probabilities.size) { sum += probabilities[it]; sum }
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 1000
    val iub = accumulate(doubleArrayOf(0.27, 0.12, 0.12, 0.27) + DoubleArray(11) { 0.02 })
    val homo = accumulate(doubleArrayOf(0.3029549426680, 0.1979883004921, 0.1975473066391, 0.3015094502008))
    val at = State()

    at.repeated(n * 2)
    at.random("acgtBDHKMNRSVWY", iub, n * 3)
    at.random("acgt", homo, n * 5)
    println("${at.count} ${at.hash}")
}
