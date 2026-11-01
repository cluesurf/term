object log {
    fun writeInfo(message: String) { kotlin.io.println(message) }
    fun writeWarn(message: String) { System.err.println(message) }
    fun writeError(message: String) { System.err.println(message) }
    fun writeDebug(message: String) { kotlin.io.println(message) }
}
