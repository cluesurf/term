// Subprocess runner over java.lang.ProcessBuilder. Runs the command to completion, capturing stdout and stderr, and
// returns the exit code with both streams. A failure returns code -1 and the error text, so the public run API stays
// total. `directory` (empty is this process's own) and `environment` (entries added over the inherited one) shape the
// child, and a directory that is not there fails the start, as a missing command does. The JVM answers 128 plus the
// signal's number for a child a signal ended, so `code` agrees with the other targets, but it cannot tell that from an
// `exit` of the same number: `signal` is always 0 here. Fully qualified (no top-level imports) so the file can be
// prepended as a runtime prelude. Reached only through the public run API.
object runner {
    // a child's environment is the program's: what `set-variable` stored (`term.env.<NAME>`) and removed
    // (`term.env-removed.<NAME>`), over the process's own, as a node child inherits `process.env` (env-variable.kt),
    // and then the entries the caller adds
    fun builder(command: String, argumentList: List<String>, directory: String, added: Map<String, String>): ProcessBuilder {
        val builder = ProcessBuilder(listOf(command) + argumentList)
        val environment = builder.environment()
        for (key in System.getProperties().stringPropertyNames()) {
            if (key.startsWith("term.env-removed.")) {
                environment.remove(key.removePrefix("term.env-removed."))
            } else if (key.startsWith("term.env.")) {
                environment[key.removePrefix("term.env.")] = System.getProperty(key) ?: ""
            }
        }
        environment.putAll(added)
        if (directory.isNotEmpty()) {
            builder.directory(java.io.File(directory))
        }
        return builder
    }

    suspend fun run(command: String, argumentList: List<String>, directory: String, environment: Map<String, String>): RunResult {
        return try {
            val process = builder(command, argumentList, directory, environment).start()
            val output = process.inputStream.bufferedReader().readText()
            val error = process.errorStream.bufferedReader().readText()
            val code = process.waitFor()
            RunResult(code.toLong(), output, error, 0L)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString(), 0L)
        }
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code, -1 when it could not start
    suspend fun attached(command: String, argumentList: List<String>, directory: String, environment: Map<String, String>): Long {
        return try {
            builder(command, argumentList, directory, environment).inheritIO().start().waitFor().toLong()
        } catch (cause: Throwable) {
            -1L
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    suspend fun withInput(command: String, argumentList: List<String>, input: String, directory: String, environment: Map<String, String>): RunResult {
        return try {
            val process = builder(command, argumentList, directory, environment).start()
            process.outputStream.use { it.write(input.toByteArray()) }
            val output = process.inputStream.bufferedReader().readText()
            val error = process.errorStream.bufferedReader().readText()
            val code = process.waitFor()
            RunResult(code.toLong(), output, error, 0L)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString(), 0L)
        }
    }
}
