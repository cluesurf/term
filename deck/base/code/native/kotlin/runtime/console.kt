object console {
    // the text as given, flushed: a prompt has no newline to flush it
    fun writeText(message: String) { print(message); System.out.flush() }
    fun writeLine(message: String) { println(message) }
    fun writeError(message: String) { System.err.println(message) }
}
