// Whole-path file calls for the kotlin target that never block a coroutine's dispatcher, which is to say never
// suspend, over java.nio.file. `statPath` and `listPath` build the emitted `StatRaw` and `EntryRaw` records directly
// (the shim is prepended to the module that declares them, so the types are in scope), one call each. `changed` is
// seconds times 1000 plus nanoseconds over 1e6 in a Double, read from the file time's instant, which keeps the
// nanoseconds the way node's `mtimeMs` does (`toMillis()` would drop the fraction).
//
// `kotlin.Exception` is spelled out: a program that loads the stdlib's `exception` form emits a class of that name
// (`Exception<P>`) beside this object, and a bare `Exception` then names it.
//
// Reached only through the public file/blocking API, which has already ruled out a missing path.
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths

object blocking {
  fun readPath(path: String): String =
    try {
      String(Files.readAllBytes(Paths.get(path)), Charsets.UTF_8)
    } catch (error: kotlin.Exception) {
      ""
    }

  // a symbolic link is followed, so a link to nothing is not there
  fun existsPath(path: String): Boolean =
    try {
      Files.exists(Paths.get(path))
    } catch (error: kotlin.Exception) {
      false
    }

  fun statPath(path: String): StatRaw =
    try {
      val at = Paths.get(path)
      val kind =
        when {
          Files.isDirectory(at) -> "directory"
          Files.isRegularFile(at) -> "file"
          else -> "other"
        }
      val moment = Files.getLastModifiedTime(at).toInstant()

      StatRaw(
        kind,
        Files.size(at),
        moment.epochSecond.toDouble() * 1000.0 + moment.nano.toDouble() / 1e6,
      )
    } catch (error: kotlin.Exception) {
      StatRaw("other", 0L, 0.0)
    }

  // the platform's own order, no `.` or `..`, each kind the entry's own with links not followed
  fun listPath(path: String): MutableList<EntryRaw> {
    val out = mutableListOf<EntryRaw>()

    try {
      Files.newDirectoryStream(Paths.get(path)).use { entries ->
        for (entry in entries) {
          val kind =
            when {
              Files.isSymbolicLink(entry) -> "link"
              Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS) -> "directory"
              Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS) -> "file"
              else -> "other"
            }

          out.add(EntryRaw(entry.fileName.toString(), kind))
        }
      }
    } catch (error: kotlin.Exception) {
      return out
    }

    return out
  }

  fun realPath(path: String): String =
    try {
      Paths.get(path).toRealPath().toString()
    } catch (error: kotlin.Exception) {
      path
    }
}
