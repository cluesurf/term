// Integer math over the JVM (Long). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
object imath {
    // `abs(Long.MIN_VALUE)` is MIN_VALUE again on the JVM, a different integer: it stops instead
    fun abs(value: Long): Long = if (value == Long.MIN_VALUE) throw ArithmeticException("excess: a number past Long") else kotlin.math.abs(value)
    fun min(a: Long, b: Long): Long = minOf(a, b)
    fun max(a: Long, b: Long): Long = maxOf(a, b)
    // the integer power or a stop (note/term/proof-by-default/numbers.md): by squaring with Math.multiplyExact, so a
    // result past Long throws instead of saturating. Through Double it was wrong above 2^53 and capped at Long.MAX_VALUE.
    // A negative exponent is the real result truncated toward zero: 0, except for a base of 1 or -1. Rust and Swift
    // answer the same (imath.rs, imath.swift)
    fun pow(base: Long, exponent: Long): Long {
        if (exponent < 0) return if (base == 1L) 1L else if (base == -1L) (if (exponent % 2 == 0L) 1L else -1L) else if (base == 0L) throw ArithmeticException("defect: zero to a negative power") else 0L
        var result = 1L
        var b = base
        var e = exponent
        while (e > 0) {
            if (e and 1L == 1L) result = Math.multiplyExact(result, b)
            e = e shr 1
            if (e > 0) b = Math.multiplyExact(b, b)
        }
        return result
    }
    fun signum(value: Long): Long = value.compareTo(0L).toLong()
    fun sqrt(value: Long): Long = Math.sqrt(value.toDouble()).toLong()
    fun log(value: Long): Long = kotlin.math.ln(value.toDouble()).toLong()
    fun sin(value: Long): Long = kotlin.math.sin(value.toDouble()).toLong()
}
