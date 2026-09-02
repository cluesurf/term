// Filesystem watching for the kotlin target, over java.nio.file.WatchService: the JDK's own watcher, not a
// polling loop and not a dependency.
//
// The API is PULL, not callback: `watchOpen` registers the watch, `watchNext` awaits the next change, and
// `watchClose` stops it. WatchService is already pull-shaped (`take()` blocks until a change), so the whole shim
// is that call moved onto `Dispatchers.IO` and the JDK's three event kinds renamed to the four the Term API uses.
//
// Reached only through the public file/watch API.
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardWatchEventKinds
import java.nio.file.WatchService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object watch {
  // the running watch: the service, the directories registered with it (so a key can be turned back into a path),
  // and whether it has been closed
  class Watcher(val service: WatchService?, val roots: MutableMap<Any, Path>) {
    var closed = false
  }

  suspend fun watchOpen(path: String, deep: Boolean): Watcher = withContext(Dispatchers.IO) {
    try {
      val service = FileSystems.getDefault().newWatchService()
      val roots = mutableMapOf<Any, Path>()
      val root = Paths.get(path)

      register(service, roots, root)

      if (deep) {
        // WatchService registers ONE directory at a time, so a deep watch is every directory beneath the root
        // registered up front. A directory created later is not covered, which is the JDK's own limitation and
        // is named in note/term/stdlib/native-async-file-and-server.md.
        Files.walk(root).use { tree ->
          for (child in tree) {
            if (Files.isDirectory(child) && child != root) {
              register(service, roots, child)
            }
          }
        }
      }

      Watcher(service, roots)
    } catch (error: Exception) {
      Watcher(null, mutableMapOf())
    }
  }

  private fun register(service: WatchService, roots: MutableMap<Any, Path>, at: Path) {
    val key =
      at.register(
        service,
        StandardWatchEventKinds.ENTRY_CREATE,
        StandardWatchEventKinds.ENTRY_DELETE,
        StandardWatchEventKinds.ENTRY_MODIFY,
      )
    roots[key] = at
  }

  // the next change. A closed watcher answers with the empty event rather than waiting forever, so a loop over
  // `watchNext` ends after `watchClose`.
  suspend fun watchNext(watcher: Watcher): WatchEvent = withContext(Dispatchers.IO) {
    val service = watcher.service

    if (service == null || watcher.closed) {
      return@withContext WatchEvent("", "")
    }

    try {
      while (true) {
        val key = service.take()
        val root = watcher.roots[key] ?: Paths.get(".")
        val events = key.pollEvents()
        key.reset()

        for (event in events) {
          val kind =
            when (event.kind()) {
              StandardWatchEventKinds.ENTRY_CREATE -> "create"
              StandardWatchEventKinds.ENTRY_DELETE -> "remove"
              StandardWatchEventKinds.ENTRY_MODIFY -> "change"
              else -> "other"
            }
          val at = event.context()

          return@withContext WatchEvent(
            kind,
            if (at is Path) root.resolve(at).toString() else root.toString(),
          )
        }
      }

      @Suppress("UNREACHABLE_CODE")
      WatchEvent("", "")
    } catch (error: Exception) {
      WatchEvent("", "")
    }
  }

  suspend fun watchClose(watcher: Watcher) {
    withContext(Dispatchers.IO) {
      watcher.closed = true

      try {
        watcher.service?.close()
      } catch (error: Exception) {
        null
      }
    }
  }
}
