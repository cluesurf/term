object hex {
    private val digits = "0123456789abcdef".toCharArray()
    // two digits per byte from a table into one CharArray, as bytes.kt does: it formatted each byte with String.format,
    // which parses the format string again for every byte
    fun encode(input: String): String {
        val value = input.toByteArray(Charsets.UTF_8)
        val out = CharArray(value.size * 2)
        for (i in value.indices) { val b = value[i].toInt() and 0xff; out[i * 2] = digits[b ushr 4]; out[i * 2 + 1] = digits[b and 0xf] }
        return String(out)
    }
    fun decode(input: String): String = String(input.chunked(2).map { it.toInt(16).toByte() }.toByteArray(), Charsets.UTF_8)
}
