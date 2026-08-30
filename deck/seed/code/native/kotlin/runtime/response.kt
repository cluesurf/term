// HTTP response body decoding. The raw response arrives as a map; each accessor pulls the body out in the shape the
// caller wants, defaulting rather than throwing when it is absent. Reached only through the public network API.
object responseRuntime {
    // the response arrives as whatever record the caller holds: a map from the transport, or a generated
    // record class whose `body` property is read reflectively
    private fun bodyOf(raw: Any?): String {
        if (raw is Map<*, *>) return raw["body"] as? String ?: ""
        if (raw == null) return ""
        return try {
            val field = raw.javaClass.getDeclaredField("body")
            field.isAccessible = true
            field.get(raw) as? String ?: ""
        } catch (e: Exception) {
            ""
        }
    }

    fun text(raw: Any?): String = bodyOf(raw)

    fun bytes(raw: Any?): ByteArray = bodyOf(raw).toByteArray()

    // the body as the dynamic JSON value, through the stdlib's own reader (runtime/json.kt)
    fun jsonBody(raw: Any?): Any {
        val body = bodyOf(raw)
        return json.parse(if (body.isEmpty()) "{}" else body)
    }
}
