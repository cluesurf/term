// Current-process runtime for the kotlin target. Reached only through the public process API.
//
// NAMED GAP on `listen`: the JVM has no portable signal API. `sun.misc.Signal` exists and is internal, and
// depending on it makes the stdlib break on a JDK that closes it off. A shutdown hook is the supported answer and
// it fires for SIGTERM and SIGINT alike, so "terminate" and "interrupt" both register there and "hangup" cannot
// be told apart from either. Recorded in note/term/stdlib/native-async-file-and-server.md.
object current {
  fun id(): Long = ProcessHandle.current().pid()

  // the program's own arguments, as on every backend. `main(args)` sees them, and an entry point may store them in
  // `given`. Without one, they are what follows the main class or jar in the JVM's own argument array
  // (`ProcessHandle`'s, after `-cp` and the other options), each argument whole. The main is the first word of the
  // launcher's line, `sun.java.command`. That line, split on spaces, was the whole answer until 2026-10-04, and an
  // argument holding a space arrived as two (guides: library/processes). It is the answer still where the JVM
  // cannot report its arguments
  @JvmStatic var given: Array<String>? = null

  fun arguments(): MutableList<String> {
    given?.let { return it.toMutableList() }
    val words = (System.getProperty("sun.java.command") ?: "").split(" ").filter { it.isNotEmpty() }
    val main = words.firstOrNull()
    val raw = ProcessHandle.current().info().arguments().orElse(null)
    val at = if (main != null && raw != null) raw.indexOf(main) else -1
    return if (at >= 0) raw!!.drop(at + 1).toMutableList() else words.drop(1).toMutableList()
  }

  fun directory(): String = System.getProperty("user.dir") ?: ""

  fun executable(): String = ProcessHandle.current().info().command().orElse("")

  fun exit(code: Long): Nothing {
    System.exit(code.toInt())
    throw RuntimeException("unreachable")
  }

  // `signal` is one of "terminate", "interrupt", "hangup"; anything else is ignored
  fun listen(signal: String, handler: () -> Unit) {
    when (signal) {
      "terminate", "interrupt", "hangup" ->
        Runtime.getRuntime().addShutdownHook(Thread { handler() })
      else -> return
    }
  }
}
