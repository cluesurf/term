// Named `strings`, not `text`: a runtime's namespace sits in the program's own, and the render runtime has a task
// `text` (a text node), so a program reaching both did not build (native-dom-0042).
//
// Positions and lengths count CODE POINTS, as the emitter's TermText and every other backend do
// (note/term/stdlib/semantics.md). They counted UTF-16 units until 2026-10-02, so one program measured a text with an
// emoji differently depending on which of the two runtimes a module reached. Bounds clamp to the text and never count
// from the end, and trim strips the same White_Space set as TermText. Each position is found by stepping through the
// string where it lies, so nothing is converted to an array.
object strings {
    private fun white(c: Int): Boolean = c in 9..13 || c == 32 || c == 133 || c == 160 || c == 5760 || c in 8192..8202 || c == 8232 || c == 8233 || c == 8239 || c == 8287 || c == 12288
    // the UTF-16 offset of code point i, clamped to the text
    private fun unit(s: String, i: Long): Int {
        var u = 0
        var k = 0L
        while (k < i && u < s.length) {
            u += Character.charCount(s.codePointAt(u))
            k++
        }
        return u
    }
    fun concat(a: String, b: String): String = a + b
    fun upper(s: String): String = s.uppercase()
    fun lower(s: String): String = s.lowercase()
    fun trim(s: String): String {
        var a = 0
        while (a < s.length) { val c = s.codePointAt(a); if (!white(c)) break; a += Character.charCount(c) }
        var b = s.length
        while (b > a) { val c = s.codePointBefore(b); if (!white(c)) break; b -= Character.charCount(c) }
        return s.substring(a, b)
    }
    fun repeated(s: String, n: Long): String = if (n > 0) s.repeat(n.toInt()) else ""
    fun contains(s: String, part: String): Boolean = s.contains(part)
    fun startsWith(s: String, prefix: String): Boolean = s.startsWith(prefix)
    fun endsWith(s: String, suffix: String): Boolean = s.endsWith(suffix)
    fun replace(s: String, from: String, to: String): String = s.replace(from, to)
    // both bounds clamped to the text, and a start after the end swapped with it, as TermText.substring does
    fun slice(s: String, start: Long, end: Long): String {
        var x = maxOf(start, 0L)
        var y = maxOf(end, 0L)
        if (x > y) { val t = x; x = y; y = t }
        val a = unit(s, x)
        val b = a + unit(s.substring(a), y - x)
        return s.substring(a, b)
    }
    fun sliceFrom(s: String, start: Long): String = s.substring(unit(s, maxOf(start, 0L)))
    fun indexOf(s: String, search: String, start: Long): Long {
        val r = s.indexOf(search, unit(s, maxOf(start, 0L)))
        return if (r < 0) -1L else s.codePointCount(0, r).toLong()
    }
    fun replaceFirst(s: String, from: String, to: String): String = s.replaceFirst(from, to)
    fun split(s: String, separator: String): MutableList<String> = s.split(separator).toMutableList()
    fun join(list: List<String>, separator: String): String = list.joinToString(separator)
    fun length(s: String): Long = s.codePointCount(0, s.length).toLong()
}
