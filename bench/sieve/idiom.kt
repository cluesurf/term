// Sieve, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Kotlin (ours,
// 2026-10-03): a BooleanArray of flags made full, each prime's multiples cleared, the count run `n` times and added
fun countPrimes(flags: BooleanArray, size: Int): Int {
    var primes = 0

    for (i in 2..size) {
        if (flags[i - 1]) {
            primes++

            for (k in i + i..size step i) {
                flags[k - 1] = false
            }
        }
    }

    return primes
}

fun main(args: Array<String>) {
    val n = args.firstOrNull()?.toIntOrNull() ?: 3
    var total = 0L

    repeat(n) {
        total += countPrimes(BooleanArray(5000) { true }, 5000)
    }

    println(total)
}
