// The one regex primitive over java.util.regex. The pattern arrives in the canonical dialect
// (base/code/regex/dialect.tree); this runs it and turns UTF-16 offsets into code point offsets.
object regex {
    private val compiled = HashMap<String, java.util.regex.Pattern>()

    fun search(pattern: String, text: String, from: Long): MutableList<Long> {
        val out = mutableListOf<Long>()
        val engine = compiled[pattern] ?: try {
            java.util.regex.Pattern.compile(pattern).also { compiled[pattern] = it }
        } catch (e: Throwable) {
            return out
        }
        val count = text.codePointCount(0, text.length)
        if (from < 0 || from > count) return out
        val unit = text.offsetByCodePoints(0, from.toInt())
        val found = engine.matcher(text)
        if (!found.find(unit)) return out
        for (group in 0..found.groupCount()) {
            val start = found.start(group)
            if (start < 0) {
                out.add(-1L)
                out.add(-1L)
            } else {
                out.add(from + text.codePointCount(unit, start))
                out.add(from + text.codePointCount(unit, found.end(group)))
            }
        }
        return out
    }
}
