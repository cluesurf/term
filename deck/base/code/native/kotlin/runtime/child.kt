// Child process runtime. Reached only through the public process API.
object childRuntime {
    // the dock handle arrives as the dynamic; a handle of the wrong shape reads as a finished process
    private fun of(dock: Any?): Process? = dock as? Process

    fun wait(dock: Any?): Long {
        val proc = of(dock) ?: return -1L
        proc.waitFor()

        return proc.exitValue().toLong()
    }

    fun stop(dock: Any?) {
        of(dock)?.destroy()
    }

    fun kill(dock: Any?) {
        of(dock)?.destroyForcibly()
    }

    fun write(dock: Any?, data: String) {
        of(dock)?.outputStream?.write(data.toByteArray())
    }

    fun close(dock: Any?) {
        of(dock)?.outputStream?.close()
    }

    fun readOut(dock: Any?): String =
        of(dock)?.inputStream?.bufferedReader()?.readText() ?: ""

    fun readError(dock: Any?): String =
        of(dock)?.errorStream?.bufferedReader()?.readText() ?: ""
}
