// HTTP response body decoding. The raw response arrives as a map; each accessor pulls the body out in the shape the
// caller wants, defaulting rather than throwing when it is absent. Reached only through the public network API.
object response {
    fun text(raw: Map<String, Any?>): String = raw["body"] as? String ?: ""

    fun bytes(raw: Map<String, Any?>): ByteArray =
        (raw["body"] as? String ?: "").toByteArray()

    fun json(raw: Map<String, Any?>): org.json.JSONObject =
        org.json.JSONObject(raw["body"] as? String ?: "{}")
}
