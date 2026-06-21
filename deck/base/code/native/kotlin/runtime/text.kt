object text {
    fun upper(s: String): String = s.uppercase()
    fun lower(s: String): String = s.lowercase()
    fun trim(s: String): String = s.trim()
    fun repeated(s: String, n: Long): String = s.repeat(n.toInt())
    fun contains(s: String, part: String): Boolean = s.contains(part)
    fun startsWith(s: String, prefix: String): Boolean = s.startsWith(prefix)
    fun endsWith(s: String, suffix: String): Boolean = s.endsWith(suffix)
    fun replace(s: String, from: String, to: String): String = s.replace(from, to)
    fun slice(s: String, start: Long, end: Long): String = s.substring(start.toInt(), end.toInt())
}
