// Integer math over the JVM (Long). Mirrors the host Math operations the other targets use. Reached only through the
// public math API.
object imath {
    fun abs(value: Long): Long = kotlin.math.abs(value)
    fun min(a: Long, b: Long): Long = minOf(a, b)
    fun max(a: Long, b: Long): Long = maxOf(a, b)
    fun pow(base: Long, exponent: Long): Long = Math.pow(base.toDouble(), exponent.toDouble()).toLong()
    fun signum(value: Long): Long = value.compareTo(0L).toLong()
    fun sqrt(value: Long): Long = Math.sqrt(value.toDouble()).toLong()
}
