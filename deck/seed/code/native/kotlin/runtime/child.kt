// Child process runtime. Reached only through the public process API.
object childRuntime {
    fun wait(proc: Process): Long {
        proc.waitFor()

        return proc.exitValue().toLong()
    }

    fun stop(proc: Process) {
        proc.destroy()
    }

    fun kill(proc: Process) {
        proc.destroyForcibly()
    }

    fun write(proc: Process, data: String) {
        proc.outputStream.write(data.toByteArray())
    }

    fun close(proc: Process) {
        proc.outputStream.close()
    }

    fun readOut(proc: Process): String =
        proc.inputStream.bufferedReader().readText()

    fun readError(proc: Process): String =
        proc.errorStream.bufferedReader().readText()
}
