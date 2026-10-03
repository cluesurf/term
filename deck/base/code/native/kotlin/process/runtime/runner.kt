// Subprocess runner over java.lang.ProcessBuilder. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A failure returns code -1 and the error text, so the public run API stays
// total. Fully qualified (no top-level imports) so the file can be prepended as a runtime prelude. Reached only through
// the public run API.
object runner {
    suspend fun run(command: String, argumentList: List<String>): RunResult {
        return try {
            val process = ProcessBuilder(listOf(command) + argumentList).start()
            val output = process.inputStream.bufferedReader().readText()
            val error = process.errorStream.bufferedReader().readText()
            val code = process.waitFor()
            RunResult(code.toLong(), output, error)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString())
        }
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code, -1 when it could not start
    suspend fun attached(command: String, argumentList: List<String>): Long {
        return try {
            ProcessBuilder(listOf(command) + argumentList).inheritIO().start().waitFor().toLong()
        } catch (cause: Throwable) {
            -1L
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    suspend fun withInput(command: String, argumentList: List<String>, input: String): RunResult {
        return try {
            val process = ProcessBuilder(listOf(command) + argumentList).start()
            process.outputStream.use { it.write(input.toByteArray()) }
            val output = process.inputStream.bufferedReader().readText()
            val error = process.errorStream.bufferedReader().readText()
            val code = process.waitFor()
            RunResult(code.toLong(), output, error)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString())
        }
    }
}
