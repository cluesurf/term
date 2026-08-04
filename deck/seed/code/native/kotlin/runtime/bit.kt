// Bitwise integer operations over the JVM (full 64-bit Long). Reached only through the public bit API.
object bit {
    fun and(left: Long, right: Long): Long = left and right
    fun or(left: Long, right: Long): Long = left or right
    fun exclusiveOr(left: Long, right: Long): Long = left xor right
    fun not(value: Long): Long = value.inv()
    fun shiftLeft(value: Long, count: Long): Long = value shl count.toInt()
    fun shiftRight(value: Long, count: Long): Long = value shr count.toInt()
    fun shiftRightUnsigned(value: Long, count: Long): Long = value ushr count.toInt()
}
