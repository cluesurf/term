// Runtime shape checks. The type system cannot answer these, so they are a platform capability like any other:
// the host is asked what a value actually is. Reached only through the public shape API.
object shape {
    fun isList(value: Any?): Boolean = value is List<*>

    // the same answer as typeOf's `number`, on every backend (item term-self-host-001-1091)
    fun isNumber(value: Any?): Boolean = value is Number

    fun isText(value: Any?): Boolean = value is String

    fun isNull(value: Any?): Boolean = value == null

    fun typeOf(value: Any?): String = when (value) {
        null -> "null"
        is List<*> -> "list"
        is String -> "text"
        is Boolean -> "boolean"
        is Number -> "number"
        else -> "object"
    }
    fun isPresent(value: Any?): Boolean = value != null
}
