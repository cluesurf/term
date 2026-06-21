import java.util.Base64

// Raw byte buffers over kotlin. The currency value is ByteArray.
object bytes {
    fun fromText(text: String): ByteArray = text.toByteArray(Charsets.UTF_8)
    fun toText(value: ByteArray): String = String(value, Charsets.UTF_8)
    fun toHex(value: ByteArray): String = value.joinToString("") { "%02x".format(it) }
    fun fromHex(text: String): ByteArray = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
    fun toBase64(value: ByteArray): String = Base64.getEncoder().encodeToString(value)
    fun fromBase64(text: String): ByteArray = Base64.getDecoder().decode(text)
    fun length(value: ByteArray): Long = value.size.toLong()
    fun concat(left: ByteArray, right: ByteArray): ByteArray = left + right
    fun slice(value: ByteArray, start: Long, end: Long): ByteArray = value.copyOfRange(start.toInt(), end.toInt())
}
