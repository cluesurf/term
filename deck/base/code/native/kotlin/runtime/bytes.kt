import java.util.Base64

// Raw byte buffers over kotlin. The currency value is ByteArray.
object bytes {
    fun fromText(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)
    fun toText(value: ByteArray): String = String(value, Charsets.UTF_8)
    private val digits = "0123456789abcdef".toCharArray()
    // two digits per byte from a table into one CharArray: it formatted each byte with String.format, which parses
    // the format string again for every byte
    fun toHex(value: ByteArray): String {
        val out = CharArray(value.size * 2)
        for (i in value.indices) { val b = value[i].toInt() and 0xff; out[i * 2] = digits[b ushr 4]; out[i * 2 + 1] = digits[b and 0xf] }
        return String(out)
    }
    fun fromHex(text: String): ByteArray = ByteArray(text.length / 2) { ((Character.digit(text[it * 2], 16) shl 4) or Character.digit(text[it * 2 + 1], 16)).toByte() }
    fun toBase64(value: ByteArray): String = Base64.getEncoder().encodeToString(value)
    fun fromBase64(text: String): ByteArray = Base64.getDecoder().decode(text)
    fun length(value: ByteArray): Long = value.size.toLong()
    fun concat(left: ByteArray, right: ByteArray): ByteArray = left + right
    fun slice(value: ByteArray, start: Long, end: Long): ByteArray = value.copyOfRange(start.toInt(), end.toInt())
}
