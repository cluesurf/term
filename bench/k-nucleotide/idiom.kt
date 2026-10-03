// k-nucleotide, the same generator, table and counts as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): a HashMap of every k-mer per length, keyed by the substring
fun sequence(n: Int): String {
    var seed = 42L
    val dna = StringBuilder(n)

    repeat(n) {
        seed = (seed * 3877 + 29573) % 139968
        val r = seed / 139968.0
        dna.append(if (r < 0.302954942668) 'a' else if (r < 0.5009432431601) 'c' else if (r < 0.6984905497992) 'g' else 't')
    }

    return dna.toString()
}

fun frequencies(dna: String, k: Int): HashMap<String, Int> {
    val counts = HashMap<String, Int>()

    for (i in 0..dna.length - k) {
        val key = dna.substring(i, i + k)
        counts[key] = (counts[key] ?: 0) + 1
    }

    return counts
}

fun summary(dna: String, k: Int): String {
    val counts = frequencies(dna, k)

    return "${counts.size}:${counts.values.maxOrNull() ?: 0}"
}

fun occurrences(dna: String, part: String): Int = frequencies(dna, part.length)[part] ?: 0

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 1000
    val dna = sequence(n)
    val parts = listOf("ggt", "ggta", "ggtatt", "ggtattttaatt", "ggtattttaatttatagt").map { occurrences(dna, it) }

    println("${summary(dna, 1)} ${summary(dna, 2)} ${parts.joinToString(" ")}")
}
