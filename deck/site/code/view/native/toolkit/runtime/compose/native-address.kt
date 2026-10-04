// Where the app has been, kept across a relaunch, on the DESKTOP JVM (live reload, ../../address.tree). `term work`
// starts the app with TERM_DEV_ADDRESS, the file the history is written to; without it nothing is read or written.
object nativeAddress {
    private val file: java.io.File? = System.getenv("TERM_DEV_ADDRESS")?.takeIf { it.isNotEmpty() }?.let { java.io.File(it) }

    // the history the run before this one kept, one path a line, or empty text
    fun read(): String = file?.takeIf { it.isFile }?.readText() ?: ""

    fun write(text: String) {
        file?.writeText(text)
    }
}
