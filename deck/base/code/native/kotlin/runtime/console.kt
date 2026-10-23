object console {
    // the text as given, flushed: a prompt has no newline to flush it. Kotlin's own `print`, named whole: a program's
    // task called `print` (@term/base/debug) is a top-level function of the same file and wins over the implicit import
    fun writeText(message: String) { kotlin.io.print(message); System.out.flush() }
    fun writeLine(message: String) { kotlin.io.println(message) }
    fun writeError(message: String) { System.err.println(message) }
}
