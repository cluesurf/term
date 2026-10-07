// Subprocess runner over the JDK's Foreign Function & Memory API (java.lang.foreign), calling posix_spawnp and waitpid
// of the C library. MINIMUM JDK 22, where the API is final and takes no flag: an older JDK makes every call here
// answer code -1 with a message naming the JDK in use (`needJdk`). It is used and not java.lang.ProcessBuilder because
// the JVM reaps its own children and folds a signal death into 128 plus the number, so a child a signal ended could
// not be told from an `exit` of that number. Here waitpid hands over the raw status: a death by signal n answers code
// 128+n and signal n, and `exit 143` answers code 143 and signal 0, as node, rust and swift do. Runs the command to
// completion, capturing stdout and stderr (read at the same time, on two threads, so a child filling one pipe never
// waits on the other), and returns the exit code with both streams. A failure returns code -1 and the error text, so
// the public run API stays total. `directory` (empty is this process's own) and `environment` (entries added over the
// inherited one, after what `set-variable` stored as `term.env.<NAME>` and removed as `term.env-removed.<NAME>`) shape
// the child, and a directory that is not there fails the start, as a missing command does. `attached` spawns with no
// pipes, so the child keeps this terminal. Fully qualified (no top-level imports) so the file can be prepended as a
// runtime prelude. Reached only through the public run API. Native access is restricted: a JDK 24 or newer prints one
// warning to stderr unless the program runs with --enable-native-access=ALL-UNNAMED.
object runner {
    // a child's environment is the program's: what `set-variable` stored and removed, over the process's own, as a node
    // child inherits `process.env` (env-variable.kt), and then the entries the caller adds
    fun environmentOf(added: Map<String, String>): Map<String, String> {
        val environment = LinkedHashMap<String, String>(System.getenv())
        for (key in System.getProperties().stringPropertyNames()) {
            if (key.startsWith("term.env-removed.")) {
                environment.remove(key.removePrefix("term.env-removed."))
            } else if (key.startsWith("term.env.")) {
                environment[key.removePrefix("term.env.")] = System.getProperty(key) ?: ""
            }
        }
        environment.putAll(added)
        return environment
    }

    fun needJdk() {
        val feature = Runtime.version().feature()
        if (feature < 22) {
            throw IllegalStateException("term process run needs JDK 22 or newer (the java.lang.foreign API), this is JDK " + feature)
        }
    }

    // the C library's functions, looked up once
    class Native(
        val pipe: java.lang.invoke.MethodHandle,
        val read: java.lang.invoke.MethodHandle,
        val write: java.lang.invoke.MethodHandle,
        val close: java.lang.invoke.MethodHandle,
        val waitpid: java.lang.invoke.MethodHandle,
        val spawn: java.lang.invoke.MethodHandle,
        val actionsInit: java.lang.invoke.MethodHandle,
        val actionsDestroy: java.lang.invoke.MethodHandle,
        val adddup2: java.lang.invoke.MethodHandle,
        val addclose: java.lang.invoke.MethodHandle,
        val addchdir: java.lang.invoke.MethodHandle?,
    )

    val native: Native by lazy {
        needJdk()
        val linker = java.lang.foreign.Linker.nativeLinker()
        val lookup = linker.defaultLookup()
        val int = java.lang.foreign.ValueLayout.JAVA_INT
        val long = java.lang.foreign.ValueLayout.JAVA_LONG
        val pointer = java.lang.foreign.ValueLayout.ADDRESS
        fun find(name: String, description: java.lang.foreign.FunctionDescriptor): java.lang.invoke.MethodHandle? {
            val symbol = lookup.find(name)
            return if (symbol.isPresent) linker.downcallHandle(symbol.get(), description) else null
        }
        fun need(name: String, description: java.lang.foreign.FunctionDescriptor): java.lang.invoke.MethodHandle {
            return find(name, description) ?: throw IllegalStateException("the C library has no " + name)
        }
        Native(
            need("pipe", java.lang.foreign.FunctionDescriptor.of(int, pointer)),
            need("read", java.lang.foreign.FunctionDescriptor.of(long, int, pointer, long)),
            need("write", java.lang.foreign.FunctionDescriptor.of(long, int, pointer, long)),
            need("close", java.lang.foreign.FunctionDescriptor.of(int, int)),
            need("waitpid", java.lang.foreign.FunctionDescriptor.of(int, int, pointer, int)),
            need("posix_spawnp", java.lang.foreign.FunctionDescriptor.of(int, pointer, pointer, pointer, pointer, pointer, pointer)),
            need("posix_spawn_file_actions_init", java.lang.foreign.FunctionDescriptor.of(int, pointer)),
            need("posix_spawn_file_actions_destroy", java.lang.foreign.FunctionDescriptor.of(int, pointer)),
            need("posix_spawn_file_actions_adddup2", java.lang.foreign.FunctionDescriptor.of(int, pointer, int, int)),
            need("posix_spawn_file_actions_addclose", java.lang.foreign.FunctionDescriptor.of(int, pointer, int)),
            find("posix_spawn_file_actions_addchdir_np", java.lang.foreign.FunctionDescriptor.of(int, pointer, pointer)),
        )
    }

    fun call(handle: java.lang.invoke.MethodHandle, vararg arguments: Any?): Any? {
        return handle.invokeWithArguments(*arguments)
    }

    fun makePipe(arena: java.lang.foreign.Arena): IntArray {
        val fds = arena.allocate(8L, 4L)
        val answer = call(native.pipe, fds) as Int
        if (answer != 0) {
            throw IllegalStateException("pipe failed")
        }
        return intArrayOf(fds.get(java.lang.foreign.ValueLayout.JAVA_INT, 0L), fds.get(java.lang.foreign.ValueLayout.JAVA_INT, 4L))
    }

    fun closeFd(fd: Int) {
        if (fd >= 0) {
            call(native.close, fd)
        }
    }

    // posix_spawnp the command, wiring `pipes` (stdin read end, stdout write end, stderr write end, then the parent's
    // ends to close in the child) when given; the pid
    fun spawn(arena: java.lang.foreign.Arena, command: String, argumentList: List<String>, directory: String, added: Map<String, String>, pipes: List<IntArray>?): Int {
        val pointer = java.lang.foreign.ValueLayout.ADDRESS
        if (directory.isNotEmpty() && !java.io.File(directory).isDirectory) {
            throw IllegalStateException("no such directory: " + directory)
        }
        val actions = arena.allocate(512L, 16L)
        call(native.actionsInit, actions)
        try {
            if (directory.isNotEmpty()) {
                val change = native.addchdir ?: throw IllegalStateException("no posix_spawn_file_actions_addchdir_np on this system")
                call(change, actions, arena.allocateFrom(directory))
            }
            if (pipes != null) {
                val stdin = pipes[0]
                val stdout = pipes[1]
                val stderr = pipes[2]
                call(native.adddup2, actions, stdin[0], 0)
                call(native.adddup2, actions, stdout[1], 1)
                call(native.adddup2, actions, stderr[1], 2)
                for (fd in listOf(stdin[0], stdin[1], stdout[0], stdout[1], stderr[0], stderr[1])) {
                    if (fd > 2) {
                        call(native.addclose, actions, fd)
                    }
                }
            }
            val words = listOf(command) + argumentList
            val argv = arena.allocate(8L * (words.size + 1), 8L)
            for ((index, word) in words.withIndex()) {
                argv.setAtIndex(pointer, index.toLong(), arena.allocateFrom(word))
            }
            argv.setAtIndex(pointer, words.size.toLong(), java.lang.foreign.MemorySegment.NULL)
            val environment = environmentOf(added).entries.toList()
            val envp = arena.allocate(8L * (environment.size + 1), 8L)
            for ((index, entry) in environment.withIndex()) {
                envp.setAtIndex(pointer, index.toLong(), arena.allocateFrom(entry.key + "=" + entry.value))
            }
            envp.setAtIndex(pointer, environment.size.toLong(), java.lang.foreign.MemorySegment.NULL)
            val pid = arena.allocate(4L, 4L)
            val answer = call(native.spawn, pid, arena.allocateFrom(command), actions, java.lang.foreign.MemorySegment.NULL, argv, envp) as Int
            if (answer != 0) {
                throw IllegalStateException("could not start " + command + " (error " + answer + ")")
            }
            return pid.get(java.lang.foreign.ValueLayout.JAVA_INT, 0L)
        } finally {
            call(native.actionsDestroy, actions)
        }
    }

    // waitpid's raw status as (code, signal): a signal's death is 128 plus its number and that number, an exit its code and 0
    fun wait(arena: java.lang.foreign.Arena, pid: Int): LongArray {
        val status = arena.allocate(4L, 4L)
        var tries = 0
        while (true) {
            val answer = call(native.waitpid, pid, status, 0) as Int
            if (answer == pid) {
                break
            }
            tries += 1
            if (tries > 1000) {
                throw IllegalStateException("waitpid failed")
            }
        }
        val raw = status.get(java.lang.foreign.ValueLayout.JAVA_INT, 0L)
        val signal = raw and 0x7f
        return if (signal == 0) longArrayOf(((raw shr 8) and 0xff).toLong(), 0L) else longArrayOf(128L + signal, signal.toLong())
    }

    // everything the descriptor yields until it ends, then closed
    fun drain(fd: Int): ByteArray {
        val arena = java.lang.foreign.Arena.ofConfined()
        try {
            val buffer = arena.allocate(65536L, 8L)
            val collected = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(65536)
            while (true) {
                val count = call(native.read, fd, buffer, 65536L) as Long
                if (count <= 0L) {
                    break
                }
                java.lang.foreign.MemorySegment.copy(buffer, java.lang.foreign.ValueLayout.JAVA_BYTE, 0L, chunk, 0, count.toInt())
                collected.write(chunk, 0, count.toInt())
            }
            return collected.toByteArray()
        } finally {
            arena.close()
            closeFd(fd)
        }
    }

    // `input` written to the descriptor, then closed
    fun feed(fd: Int, input: ByteArray) {
        val arena = java.lang.foreign.Arena.ofConfined()
        try {
            val buffer = arena.allocate(maxOf(input.size, 1).toLong(), 8L)
            java.lang.foreign.MemorySegment.copy(input, 0, buffer, java.lang.foreign.ValueLayout.JAVA_BYTE, 0L, input.size)
            var offset = 0L
            while (offset < input.size) {
                val count = call(native.write, fd, buffer.asSlice(offset), input.size - offset) as Long
                if (count <= 0L) {
                    break
                }
                offset += count
            }
        } finally {
            arena.close()
            closeFd(fd)
        }
    }

    fun capture(command: String, argumentList: List<String>, input: ByteArray, directory: String, environment: Map<String, String>): RunResult {
        val arena = java.lang.foreign.Arena.ofShared()
        try {
            val stdin = makePipe(arena)
            val stdout = makePipe(arena)
            val stderr = makePipe(arena)
            val pid: Int
            try {
                pid = spawn(arena, command, argumentList, directory, environment, listOf(stdin, stdout, stderr))
            } catch (cause: Throwable) {
                for (fd in listOf(stdin[0], stdin[1], stdout[0], stdout[1], stderr[0], stderr[1])) {
                    closeFd(fd)
                }
                throw cause
            }
            // the parent keeps its own ends only
            closeFd(stdin[0])
            closeFd(stdout[1])
            closeFd(stderr[1])
            var output = ByteArray(0)
            var error = ByteArray(0)
            val outputThread = Thread { output = drain(stdout[0]) }
            val errorThread = Thread { error = drain(stderr[0]) }
            val inputThread = Thread { feed(stdin[1], input) }
            outputThread.start()
            errorThread.start()
            inputThread.start()
            inputThread.join()
            outputThread.join()
            errorThread.join()
            val status = wait(arena, pid)
            return RunResult(status[0], String(output, Charsets.UTF_8), String(error, Charsets.UTF_8), status[1])
        } finally {
            arena.close()
        }
    }

    suspend fun run(command: String, argumentList: List<String>, directory: String, environment: Map<String, String>): RunResult {
        return try {
            capture(command, argumentList, ByteArray(0), directory, environment)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString(), 0L)
        }
    }

    // the command on this terminal: it reads the keyboard and writes as it goes; its exit code, -1 when it could not start
    suspend fun attached(command: String, argumentList: List<String>, directory: String, environment: Map<String, String>): Long {
        return try {
            val arena = java.lang.foreign.Arena.ofShared()
            try {
                System.out.flush()
                System.err.flush()
                val pid = spawn(arena, command, argumentList, directory, environment, null)
                wait(arena, pid)[0]
            } finally {
                arena.close()
            }
        } catch (cause: Throwable) {
            -1L
        }
    }

    // the command with `input` written to its standard input and then closed, its output captured as `run` captures it
    suspend fun withInput(command: String, argumentList: List<String>, input: String, directory: String, environment: Map<String, String>): RunResult {
        return try {
            capture(command, argumentList, input.toByteArray(), directory, environment)
        } catch (cause: Throwable) {
            RunResult(-1L, "", cause.toString(), 0L)
        }
    }
}
