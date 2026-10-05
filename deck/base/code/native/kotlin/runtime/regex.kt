// The one regex primitive over java.util.regex. The pattern arrives in a form this engine reads as Term does
// (base/code/pattern/analyze.tree, `native-text`); this runs it and turns UTF-16 offsets into code point offsets.
object regex {
    private val compiled = HashMap<String, java.util.regex.Pattern>()

    // the code point offset of UTF-16 offset `at`, counted on from a known pair, or from the text's start for a group
    // a lookbehind found before it (counting backwards from the pair would throw)
    private fun pointAt(text: String, at: Int, fromUnit: Int, fromPoint: Long): Long =
        if (at < fromUnit) text.codePointCount(0, at).toLong() else fromPoint + text.codePointCount(fromUnit, at)

    fun search(pattern: String, text: String, from: Long): MutableList<Long> {
        val out = mutableListOf<Long>()
        val engine = compiled[pattern] ?: try {
            java.util.regex.Pattern.compile(pattern).also { compiled[pattern] = it }
        } catch (e: Throwable) {
            // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
            return mutableListOf(-2L)
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
                out.add(pointAt(text, start, unit, from))
                out.add(pointAt(text, found.end(group), unit, from))
            }
        }
        return out
    }

    // every match left to right, none overlapping, in one pass: the width of one match's slots first (two per group,
    // group 0 the whole match), then each match's slots in code points. After an empty match the search moves on one
    // code point, as the Term search does, so every engine iterates alike.
    fun searchAll(pattern: String, text: String): MutableList<Long> {
        val out = mutableListOf(-1L)
        val engine = compiled[pattern] ?: try {
            java.util.regex.Pattern.compile(pattern).also { compiled[pattern] = it }
        } catch (e: Throwable) {
            // an engine that refuses the pattern answers [-2], never "no match": Term answers it with its own tier
            return mutableListOf(-2L)
        }
        val found = engine.matcher(text)
        // a cursor: the code point count at a UTF-16 offset, moved forwards only
        var cursorUnit = 0
        var cursorPoint = 0L
        var unit = 0
        while (unit <= text.length) {
            if (!found.find(unit)) break
            val start = found.start()
            val end = found.end()
            val startPoint = cursorPoint + text.codePointCount(cursorUnit, start)
            cursorUnit = start
            cursorPoint = startPoint
            out[0] = ((found.groupCount() + 1) * 2).toLong()
            for (group in 0..found.groupCount()) {
                val s = found.start(group)
                if (s < 0) {
                    out.add(-1L)
                    out.add(-1L)
                } else {
                    out.add(pointAt(text, s, start, startPoint))
                    out.add(pointAt(text, found.end(group), start, startPoint))
                }
            }
            unit = if (end > start) end else if (end < text.length) text.offsetByCodePoints(end, 1) else text.length + 1
        }
        return out
    }
}
