// HTTP response body decoding. The raw response arrives as a map; each accessor pulls the body out in the shape the
// caller wants, defaulting rather than throwing when it is absent. Reached only through the public network API.
object response {
    fun text(raw: Map<String, Any?>): String = raw["body"] as? String ?: ""

    fun bytes(raw: Map<String, Any?>): ByteArray =
        (raw["body"] as? String ?: "").toByteArray()

    // the body as the dynamic JSON value, through the stdlib's own reader (runtime/json.kt)
    fun json(raw: Map<String, Any?>): Any {
        val body = raw["body"] as? String ?: "{}"
        return json.parse(body)
    }
}
