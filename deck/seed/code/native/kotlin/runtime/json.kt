// Kotlin JSON over org.json (the JDK has no JSON parser, so this is the one base library kotlin pulls in). The parsed
// value is the opaque dynamic value (Any: a JSONObject / JSONArray / String / Number / Boolean / JSONObject.NULL).
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener

object json {
    fun parse(text: String): Any = JSONTokener(text).nextValue()
    fun stringify(value: Any): String = value.toString()
    fun getField(value: Any, key: String): Any = if (value is JSONObject && value.has(key)) value.get(key) else JSONObject.NULL
    fun getItem(value: Any, index: Int): Any = if (value is JSONArray && index >= 0 && index < value.length()) value.get(index) else JSONObject.NULL
    fun asNumber(value: Any): Double = (value as? Number)?.toDouble() ?: 0.0
    fun asText(value: Any): String = value as? String ?: ""
    fun asBoolean(value: Any): Boolean = value as? Boolean ?: false
    fun isNull(value: Any): Boolean = value === JSONObject.NULL
    fun makeObject(): Any = JSONObject()
    fun setField(value: Any, key: String, field: Any): Any { if (value is JSONObject) value.put(key, field); return value }
    fun makeArray(): Any = JSONArray()
    fun pushItem(value: Any, item: Any): Any { if (value is JSONArray) value.put(item); return value }
    fun fromText(value: String): Any = value
    fun fromNumber(value: Double): Any = value
    fun fromBoolean(value: Boolean): Any = value
    fun makeNull(): Any = JSONObject.NULL
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    fun isArray(value: Any): Boolean = value is JSONArray
    fun isObject(value: Any): Boolean = value is JSONObject
    fun isText(value: Any): Boolean = value is String
    fun isBoolean(value: Any): Boolean = value is Boolean
    fun arraySize(value: Any): Long = ((value as? JSONArray)?.length() ?: 0).toLong()
    fun arrayItem(value: Any, index: Long): Any = getItem(value, index.toInt())
    fun objectKeys(value: Any): MutableList<String> = (value as? JSONObject)?.keys()?.asSequence()?.toMutableList() ?: mutableListOf()
}
