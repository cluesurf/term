// Signals sent to another process: kill(2) of the C library over the JDK's Foreign Function & Memory API
// (java.lang.foreign, final in JDK 22), looked up as runner.kt looks it up. Its own handle, not runner.kt's: a program
// prepends only the shims it docks, and one that sends a signal need not run a command. The JVM's ProcessHandle
// `destroy` sends TERM or KILL and nothing else. Fully qualified (no top-level imports) so the file can be prepended as
// a runtime prelude. Reached only through the public process/signal API, which hands only an id from 1 to the Int
// range and a signal's POSIX number.
object signalSender {
    // kill(2), or none on a JDK or a system without it
    val kill: java.lang.invoke.MethodHandle? by kotlin.lazy {
        try {
            val linker = java.lang.foreign.Linker.nativeLinker()
            val symbol = linker.defaultLookup().find("kill")
            val int = java.lang.foreign.ValueLayout.JAVA_INT
            if (symbol.isPresent) linker.downcallHandle(symbol.get(), java.lang.foreign.FunctionDescriptor.of(int, int, int)) else null
        } catch (problem: Throwable) {
            null
        }
    }

    // whether kill(2) took the signal: false when no process has the id (ESRCH) or this one may not signal it (EPERM)
    fun send(id: Long, number: Long): Boolean {
        val handle = kill ?: return false
        return try {
            (handle.invokeWithArguments(id.toInt(), number.toInt()) as Int) == 0
        } catch (problem: Throwable) {
            false
        }
    }
}
