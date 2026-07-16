object hex {
    fun encode(input: String): String = input.toByteArray(Charsets.UTF_8).joinToString("") { "%02x".format(it) }
    fun decode(input: String): String = String(input.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), Charsets.UTF_8)
}
