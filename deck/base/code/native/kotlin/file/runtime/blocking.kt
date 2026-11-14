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
    val out = kotlin.collections.mutableListOf<EntryRaw>()

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

  // the path's own kind, links not followed (lstat), or "" when not even a link is there
  fun kindPath(path: String): String =
    try {
      val own =
        Files.readAttributes(
          Paths.get(path),
          java.nio.file.attribute.BasicFileAttributes::class.java,
          LinkOption.NOFOLLOW_LINKS,
        )

      when {
        own.isSymbolicLink -> "link"
        own.isDirectory -> "directory"
        own.isRegularFile -> "file"
        else -> "other"
      }
    } catch (error: kotlin.Exception) {
      ""
    }

  // an atomic move is rename(2) on unix: a file or an empty folder at `to` is replaced, as node's renameSync
  fun renamePath(from: String, to: String): Boolean =
    try {
      Files.move(Paths.get(from), Paths.get(to), java.nio.file.StandardCopyOption.ATOMIC_MOVE)
      true
    } catch (error: kotlin.Exception) {
      false
    }

  // rmdir(2), never recursive: Files.delete would remove a file too, so anything that is not a folder itself is refused
  // first, and a folder that holds anything throws
  fun removeFolderPath(path: String): Boolean =
    try {
      val at = Paths.get(path)

      if (!Files.isDirectory(at, LinkOption.NOFOLLOW_LINKS)) {
        false
      } else {
        Files.delete(at)
        true
      }
    } catch (error: kotlin.Exception) {
      false
    }

  // a symbolic link with the target written as given
  fun linkPath(target: String, at: String): Boolean =
    try {
      Files.createSymbolicLink(Paths.get(at), Paths.get(target))
      true
    } catch (error: kotlin.Exception) {
      false
    }

  // the whole text as UTF-8, the file made or cut, as node's writeFileSync
  fun writePath(path: String, body: String): Boolean =
    try {
      Files.write(Paths.get(path), body.toByteArray(Charsets.UTF_8))
      true
    } catch (error: kotlin.Exception) {
      false
    }
}
