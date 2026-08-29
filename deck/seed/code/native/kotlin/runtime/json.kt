// Kotlin JSON with no library: the JDK has no JSON parser and nothing sits on a bare classpath, so the reader and
// the writer live here, small and complete (RFC 8259: objects, arrays, strings with every escape, numbers, the
// three words). The parsed value is the opaque dynamic value (Any: a LinkedHashMap<String, Any> keeping key order,
// a MutableList<Any>, a String, a Double, a Boolean, or JsonNull for null).

object JsonNull

object json {
    fun parse(text: String): Any = JsonReader(text).read()

    fun stringify(value: Any): String {
        val out = StringBuilder()
        write(value, out)
        return out.toString()
    }

    // a bare number spells the way JSON does everywhere else: a whole one without a point, the rest the shortest
    // digits that read back to the same value
    private fun write(value: Any?, out: StringBuilder) {
        when (value) {
            null, JsonNull -> out.append("null")
            is Boolean -> out.append(if (value) "true" else "false")
            is Double -> out.append(if (value == Math.rint(value) && Math.abs(value) < 1e15) value.toLong().toString() else value.toString())
            is Number -> out.append(value.toString())
            is String -> writeText(value, out)
            is Map<*, *> -> {
                out.append('{')
                var first = true
                for ((key, item) in value) {
                    if (!first) out.append(',')
                    first = false
                    writeText(key.toString(), out)
                    out.append(':')
                    write(item, out)
                }
                out.append('}')
            }
            is List<*> -> {
                out.append('[')
                var first = true
                for (item in value) {
                    if (!first) out.append(',')
                    first = false
                    write(item, out)
                }
                out.append(']')
            }
            else -> writeText(value.toString(), out)
        }
    }

    private fun writeText(text: String, out: StringBuilder) {
        out.append('"')
        for (c in text) {
            when (c) {
                '"' -> out.append("\\\"")
                '\\' -> out.append("\\\\")
                '\n' -> out.append("\\n")
                '\r' -> out.append("\\r")
                '\t' -> out.append("\\t")
                '\b' -> out.append("\\b")
                '' -> out.append("\\f")
                else -> if (c < ' ') out.append(String.format("\\u%04x", c.code)) else out.append(c)
            }
        }
        out.append('"')
    }

    fun getField(value: Any, key: String): Any = if (value is Map<*, *> && value.containsKey(key)) (value[key] ?: JsonNull) else JsonNull
    fun getItem(value: Any, index: Long): Any = if (value is List<*> && index >= 0 && index < value.size) (value[index.toInt()] ?: JsonNull) else JsonNull
    fun asNumber(value: Any): Double = (value as? Number)?.toDouble() ?: 0.0
    fun asText(value: Any): String = value as? String ?: ""
    fun asBoolean(value: Any): Boolean = value as? Boolean ?: false
    fun isNull(value: Any): Boolean = value === JsonNull
    fun makeObject(): Any = LinkedHashMap<String, Any>()
    @Suppress("UNCHECKED_CAST")
    fun setField(value: Any, key: String, field: Any): Any { if (value is MutableMap<*, *>) (value as MutableMap<String, Any>)[key] = field; return value }
    fun makeArray(): Any = mutableListOf<Any>()
    @Suppress("UNCHECKED_CAST")
    fun pushItem(value: Any, item: Any): Any { if (value is MutableList<*>) (value as MutableList<Any>).add(item); return value }
    fun fromText(value: String): Any = value
    fun fromNumber(value: Double): Any = value
    fun fromBoolean(value: Boolean): Any = value
    fun makeNull(): Any = JsonNull
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    fun isArray(value: Any): Boolean = value is List<*>
    fun isObject(value: Any): Boolean = value is Map<*, *>
    fun isText(value: Any): Boolean = value is String
    fun isBoolean(value: Any): Boolean = value is Boolean
    fun arraySize(value: Any): Long = ((value as? List<*>)?.size ?: 0).toLong()
    fun arrayItem(value: Any, index: Long): Any = getItem(value, index)
    fun objectKeys(value: Any): MutableList<String> = (value as? Map<*, *>)?.keys?.map { it.toString() }?.toMutableList() ?: mutableListOf()
}

// a recursive-descent reader over the text. Malformed text reads as JsonNull, the way the other shims answer.
private class JsonReader(private val text: String) {
    private var at = 0

    fun read(): Any {
        return try {
            skip()
            val value = value()
            skip()
            if (at != text.length) JsonNull else value
        } catch (e: RuntimeException) {
            JsonNull
        }
    }

    private fun skip() { while (at < text.length && text[at].isWhitespace()) at++ }

    private fun value(): Any {
        if (at >= text.length) throw RuntimeException("end")
        return when (text[at]) {
            '{' -> obj()
            '[' -> array()
            '"' -> string()
            't' -> word("true", true)
            'f' -> word("false", false)
            'n' -> word("null", JsonNull)
            else -> number()
        }
    }

    private fun word(spelling: String, value: Any): Any {
        if (!text.startsWith(spelling, at)) throw RuntimeException("word")
        at += spelling.length
        return value
    }

    private fun obj(): Any {
        val out = LinkedHashMap<String, Any>()
        at++
        skip()
        if (at < text.length && text[at] == '}') { at++; return out }
        while (true) {
            skip()
            val key = string()
            skip()
            if (at >= text.length || text[at] != ':') throw RuntimeException("colon")
            at++
            skip()
            out[key] = value()
            skip()
            if (at >= text.length) throw RuntimeException("end")
            if (text[at] == ',') { at++; continue }
            if (text[at] == '}') { at++; return out }
            throw RuntimeException("object")
        }
    }

    private fun array(): Any {
        val out = mutableListOf<Any>()
        at++
        skip()
        if (at < text.length && text[at] == ']') { at++; return out }
        while (true) {
            skip()
            out.add(value())
            skip()
            if (at >= text.length) throw RuntimeException("end")
            if (text[at] == ',') { at++; continue }
            if (text[at] == ']') { at++; return out }
            throw RuntimeException("array")
        }
    }

    private fun string(): String {
        if (at >= text.length || text[at] != '"') throw RuntimeException("quote")
        at++
        val out = StringBuilder()
        while (true) {
            if (at >= text.length) throw RuntimeException("end")
            val c = text[at++]
            when (c) {
                '"' -> return out.toString()
                '\\' -> {
                    if (at >= text.length) throw RuntimeException("end")
                    when (val e = text[at++]) {
                        '"' -> out.append('"')
                        '\\' -> out.append('\\')
                        '/' -> out.append('/')
                        'b' -> out.append('\b')
                        'f' -> out.append('')
                        'n' -> out.append('\n')
                        'r' -> out.append('\r')
                        't' -> out.append('\t')
                        'u' -> {
                            if (at + 4 > text.length) throw RuntimeException("unicode")
                            out.append(text.substring(at, at + 4).toInt(16).toChar())
                            at += 4
                        }
                        else -> throw RuntimeException("escape $e")
                    }
                }
                else -> out.append(c)
            }
        }
    }

    private fun number(): Any {
        val start = at
        if (at < text.length && text[at] == '-') at++
        while (at < text.length && (text[at].isDigit() || text[at] == '.' || text[at] == 'e' || text[at] == 'E' || text[at] == '+' || text[at] == '-')) at++
        if (start == at) throw RuntimeException("value")
        return text.substring(start, at).toDouble()
    }
}
