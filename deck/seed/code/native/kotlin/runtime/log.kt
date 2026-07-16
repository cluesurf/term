object log {
    fun writeInfo(message: String) { println(message) }
    fun writeWarn(message: String) { println(message) }
    fun writeError(message: String) { System.err.println(message) }
    fun writeDebug(message: String) { println(message) }
}
