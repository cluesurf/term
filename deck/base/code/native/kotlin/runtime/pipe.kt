// Pipe runtime for the kotlin target: stream one child's standard output into another child's standard input
// until the source closes. Each dock handle carries the platform process as a java.lang.Process; a handle of the
// wrong shape is a no-op. The copy blocks, so it is HANDED BACK to the runtime's pool (`termLoop.handBack`,
// note/project/term/decision/001-native-work-hands-back-to-the-loop.md) and the waiting coroutine resumes on the
// loop. No kotlinx. Reached only through the public process API.

object pipeRuntime {
  private fun of(dock: Any?): Process? = dock as? Process

  suspend fun connect(from: Any?, to: Any?) {
    termLoop.handBack {
      val out = of(from)?.inputStream ?: return@handBack
      val into = of(to)?.outputStream ?: return@handBack
      val buffer = ByteArray(8192)

      try {
        while (true) {
          val read = out.read(buffer)

          if (read <= 0) break

          into.write(buffer, 0, read)
          into.flush()
        }
      } catch (error: kotlin.Exception) {
        return@handBack
      } finally {
        try {
          into.close()
        } catch (error: kotlin.Exception) {
          Unit
        }
      }
    }
  }
}
