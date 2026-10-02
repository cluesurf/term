// Current-process runtime for the kotlin target. Reached only through the public process API.
//
// NAMED GAP on `listen`: the JVM has no portable signal API. `sun.misc.Signal` exists and is internal, and
// depending on it makes the stdlib break on a JDK that closes it off. A shutdown hook is the supported answer and
// it fires for SIGTERM and SIGINT alike, so "terminate" and "interrupt" both register there and "hangup" cannot
// be told apart from either. Recorded in note/term/stdlib/native-async-file-and-server.md.
object current {
  fun id(): Long = ProcessHandle.current().pid()

  // the seed list representation on this backend
  fun arguments(): MutableList<String> =
    ProcessHandle.current().info().arguments().orElse(emptyArray()).toMutableList()

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
