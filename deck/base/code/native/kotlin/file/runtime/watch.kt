// Filesystem watching for the kotlin target, over java.nio.file.WatchService: the JDK's own watcher, not a
// polling loop and not a dependency.
//
// The API is PULL, not callback: `watchOpen` registers the watch, `watchNext` awaits the next change, and
// `watchClose` stops it. WatchService is already pull-shaped (`take()` blocks until a change), so the whole shim
// is that call HANDED BACK to the runtime's pool (`termLoop.handBack`,
// note/project/term/decision/001-native-work-hands-back-to-the-loop.md), the waiting coroutine resumed on the loop,
// and the JDK's three event kinds renamed to the four the Term API uses. No kotlinx. A `watchNext` waiting holds one
// pool worker and counts as pending work, so the loop waits for the change rather than calling it a stall.
//
// Reached only through the public file/watch API.
import java.nio.file.FileSystems
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardWatchEventKinds
import java.nio.file.WatchService

object watchFile {
  // the running watch: the service, the directories registered with it (so a key can be turned back into a path),
  // and whether it has been closed
  // and what the host refused when the watch was opened (refusal.kt), the empty code name when it opened: file/watch
  // raises it (term-self-host-001-1519)
  // A watch of a plain file is its folder's registration with only that file's changes kept (`only`), since
  // WatchService registers folders alone and node's fs.watch watches a file. `ready` holds the changes of one key's
  // batch past the one answered, so none is dropped
  class Watcher(val service: WatchService?, val roots: MutableMap<Any, Path>) {
    var closed = false
    var refusal: MutableList<String> = kotlin.collections.mutableListOf("", "", "")
    var only: Path? = null
    val ready: java.util.ArrayDeque<WatchEvent> = java.util.ArrayDeque()
  }

  // runtime-include: refusal.kt

  // a watcher that never opened, holding its refusal, and closed, so `watchNext` answers the empty event
  private fun refusedWatcher(error: Throwable): Watcher {
    val watcher = Watcher(null, kotlin.collections.mutableMapOf())
    watcher.refusal = refused(error, "watch")
    watcher.closed = true
    return watcher
  }

  // whether the nearest ancestor of a path that is there is anything but a folder: the JVM answers a path under a file
  // NoSuchFileException where the kernel says ENOTDIR (trap T-1489, file-remove.kt)
  private fun isUnderFile(path: Path): Boolean {
    var above = path.toAbsolutePath().parent
    while (above != null) {
      if (Files.exists(above)) return !Files.isDirectory(above)
      above = above.parent
    }
    return false
  }

  // A path is refused where node's fs.watch refuses it: node opens the path to read first, so a missing path is
  // ENOENT, one under a file ENOTDIR and one the run may not read EACCES, before WatchService is asked at all
  private fun watchProbe(root: Path): Throwable? =
    try {
      Files.readAttributes(root, java.nio.file.attribute.BasicFileAttributes::class.java)
      if (Files.isReadable(root)) null else java.nio.file.AccessDeniedException(root.toString())
    } catch (missing: java.nio.file.NoSuchFileException) {
      if (isUnderFile(root)) java.nio.file.FileSystemException(root.toString(), null, "Not a directory") else missing
    } catch (error: java.lang.Exception) {
      error
    }

  suspend fun watchOpen(path: String, deep: Boolean): Watcher = termLoop.handBack {
    try {
      val root = Paths.get(path)
      val probe = watchProbe(root)

      if (probe != null) {
        return@handBack refusedWatcher(probe)
      }

      val service = FileSystems.getDefault().newWatchService()
      val roots = kotlin.collections.mutableMapOf<Any, Path>()

      if (!Files.isDirectory(root)) {
        // a plain file: its folder registered, the file's own changes kept (term-self-host-001-1519)
        val folder = root.toAbsolutePath().parent
        register(service, roots, folder)
        val watcher = Watcher(service, roots)
        watcher.only = folder.resolve(root.fileName)
        return@handBack watcher
      }

      register(service, roots, root)

      if (deep) {
        // WatchService registers ONE directory at a time, so a deep watch is every directory beneath the root
        // registered up front. A directory created later is not covered, which is the JDK's own limitation and
        // is named in note/project/term/stdlib/native-async-file-and-server.md. A folder beneath the root the run
        // may not read is passed over and the rest watched, as node's fs.watch watches the rest on macOS
        // (term-self-host-001-1519): Files.walk threw on it and ended the whole watch
        Files.walkFileTree(
          root,
          object : java.nio.file.SimpleFileVisitor<Path>() {
            override fun preVisitDirectory(
              dir: Path,
              attrs: java.nio.file.attribute.BasicFileAttributes,
            ): java.nio.file.FileVisitResult {
              if (dir != root) {
                try {
                  register(service, roots, dir)
                } catch (error: java.lang.Exception) {
                  null
                }
              }
              return java.nio.file.FileVisitResult.CONTINUE
            }

            override fun visitFileFailed(file: Path, exc: java.io.IOException): java.nio.file.FileVisitResult =
              java.nio.file.FileVisitResult.CONTINUE
          },
        )
      }

      Watcher(service, roots)
    } catch (error: java.lang.Exception) {
      refusedWatcher(error)
    }
  }

  fun watchRefusal(watcher: Watcher): MutableList<String> = watcher.refusal

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
  suspend fun watchNext(watcher: Watcher): WatchEvent = termLoop.handBack {
    val service = watcher.service

    if (service == null || watcher.closed) {
      return@handBack WatchEvent("", "")
    }

    val held = watcher.ready.pollFirst()

    if (held != null) {
      return@handBack held
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
          val whole = if (at is Path) root.resolve(at) else root
          val only = watcher.only

          if (only != null && whole != only) {
            continue
          }

          watcher.ready.addLast(WatchEvent(kind, whole.toString()))
        }

        val first = watcher.ready.pollFirst()

        if (first != null) {
          return@handBack first
        }
      }

      @Suppress("UNREACHABLE_CODE")
      WatchEvent("", "")
    } catch (error: kotlin.Exception) {
      WatchEvent("", "")
    }
  }

  suspend fun watchClose(watcher: Watcher) {
    termLoop.handBack {
      watcher.closed = true

      try {
        watcher.service?.close()
      } catch (error: kotlin.Exception) {
        null
      }
    }
  }
}
