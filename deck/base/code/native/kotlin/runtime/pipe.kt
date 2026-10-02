// Pipe runtime for the kotlin target: stream one child's standard output into another child's standard input
// until the source closes. Each dock handle carries the platform process as a java.lang.Process; a handle of the
// wrong shape is a no-op. Reached only through the public process API.
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object pipeRuntime {
  private fun of(dock: Any?): Process? = dock as? Process

  suspend fun connect(from: Any?, to: Any?) {
    withContext(Dispatchers.IO) {
      val out = of(from)?.inputStream ?: return@withContext
      val into = of(to)?.outputStream ?: return@withContext
      val buffer = ByteArray(8192)

      try {
        while (true) {
          val read = out.read(buffer)

          if (read <= 0) break

          into.write(buffer, 0, read)
          into.flush()
        }
      } catch (error: Exception) {
        return@withContext
      } finally {
        try {
          into.close()
        } catch (error: Exception) {
          Unit
        }
      }
    }
  }
}
