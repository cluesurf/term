// Directory reading for the kotlin target, over java.nio.file on `Dispatchers.IO`. `dirList` is one level or every
// level as relative paths; `dirWalk` is every level as `WalkEntry` records (path, kind, depth), which is the form
// the module that docks this declares. Reached only through the public file/directory API.
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object walk {
  suspend fun dirMake(path: String) {
    withContext(Dispatchers.IO) {
      try {
        Files.createDirectories(Paths.get(path))
      } catch (error: Exception) {
        null
      }
    }
  }

  // one level, or every level below it as paths relative to `path`
  suspend fun dirList(path: String, deep: Boolean): MutableList<String> =
    withContext(Dispatchers.IO) {
      val out = mutableListOf<String>()
      val root = Paths.get(path)

      try {
        if (deep) {
          step(root) { child, _ -> out.add(root.relativize(child).toString()) }
        } else {
          Files.newDirectoryStream(root).use { entries ->
            for (entry in entries) {
              out.add(entry.fileName.toString())
            }
          }
        }
      } catch (error: Exception) {
        return@withContext out
      }

      out
    }

  // every entry beneath `path`, with what it is and how far below the root it sits. `depth` 0 walks all the way
  // down, which is what node's own recursive readdir does.
  suspend fun dirWalk(path: String, depth: Long): MutableList<WalkEntry> =
    withContext(Dispatchers.IO) {
      val out = mutableListOf<WalkEntry>()
      val root = Paths.get(path)

      try {
        step(root) { child, level ->
          if (depth == 0L || level < depth) {
            out.add(WalkEntry(child.toString(), kindOf(child), level))
          }
        }
      } catch (error: Exception) {
        return@withContext out
      }

      out
    }

  private fun kindOf(path: Path): String =
    when {
      Files.isSymbolicLink(path) -> "link"
      Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS) -> "directory"
      Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) -> "file"
      else -> "other"
    }

  // depth-first, handing each entry its level below the root. Recursion rather than Files.walk so the level is
  // known without recomputing it from the path on every entry.
  private fun step(at: Path, level: Long = 0L, take: (Path, Long) -> Unit) {
    val entries =
      try {
        Files.newDirectoryStream(at).use { it.toList() }
      } catch (error: Exception) {
        return
      }

    for (entry in entries) {
      take(entry, level)

      if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
        step(entry, level + 1L, take)
      }
    }
  }

  private fun step(at: Path, take: (Path, Long) -> Unit) = step(at, 0L, take)
}
