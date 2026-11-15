// The whole-folder remove of @term/base/file/remove for the kotlin target, over java.nio.file, never suspending. It
// answers a list of text, the refusal (refusal.kt: the code name its exception stands for, empty when carried out, the
// step and the host text) and the path the step named, which the public module raises as `failure` worded in Term
// (term/compiler decision 021 points 2, 4 and 1b).
//
// The walk is node's own (fs.rm with recursive and force: its option check's lstat, then rimraf), step for step, so a
// refusal names the step and the path node names: an lstat refused, an unlink, an rmdir, a scandir. ENOENT anywhere is
// no refusal, since nothing is there. An rmdir refused for any reason but ENOTEMPTY, EEXIST or EPERM raises at once,
// so a folder under a read-only parent keeps its entries, as node's does. `Files.delete` is the unlink of a file and
// the rmdir of a folder, by the kind the walk read.
//
// `kotlin.Exception` is spelled out: a program that loads the stdlib's `exception` form emits a class of that name
// (`Exception<P>`) beside this object, and a bare `Exception` then names it.
//
// Reached only through the public file/remove API.
object fileRemove {
  // runtime-include: refusal.kt

  private fun refusedAt(error: Throwable, step: String, path: java.nio.file.Path): MutableList<String> {
    val out = refused(error, step)
    out.add(path.toString())
    return out
  }

  private fun gone(): MutableList<String> {
    val out = carried()
    out.add("")
    return out
  }

  private fun isMissing(error: Throwable): Boolean = codeName(error) == "ENOENT"

  // lstat: whether it is a folder, never following a link, or the refusal. The JVM answers an lstat that says ENOTDIR (a
  // file above the path) as NoSuchFileException, so a missing path is told apart from one under a file by its nearest
  // ancestor that is there, as the kernel tells them: not a folder is ENOTDIR, node's word
  private fun kind(path: java.nio.file.Path): Pair<Throwable?, Boolean> =
    try {
      val found =
        java.nio.file.Files.readAttributes(
          path,
          java.nio.file.attribute.BasicFileAttributes::class.java,
          java.nio.file.LinkOption.NOFOLLOW_LINKS,
        )
      Pair(null, found.isDirectory)
    } catch (missing: java.nio.file.NoSuchFileException) {
      if (isUnderFile(path)) Pair(java.nio.file.FileSystemException(path.toString(), null, "Not a directory"), false)
      else Pair(missing, false)
    } catch (error: kotlin.Exception) {
      Pair(error, false)
    }

  // whether the nearest ancestor of a path that is there is anything but a folder (a link above is followed, as the
  // kernel follows it)
  private fun isUnderFile(path: java.nio.file.Path): Boolean {
    var above = path.toAbsolutePath().parent
    while (above != null) {
      if (java.nio.file.Files.exists(above)) return !java.nio.file.Files.isDirectory(above)
      above = above.parent
    }
    return false
  }

  private fun deleteOne(path: java.nio.file.Path): Throwable? =
    try {
      java.nio.file.Files.delete(path)
      null
    } catch (error: kotlin.Exception) {
      error
    }

  // fs.rm: the path's lstat first (a refusal but ENOENT raised), then the walk with the kind it read
  fun removePath(path: String): MutableList<String> {
    val at =
      try {
        java.nio.file.Paths.get(path)
      } catch (error: kotlin.Exception) {
        return refused(error, "lstat").also { it.add(path) }
      }
    val (refusal, folder) = kind(at)
    if (refusal != null) return if (isMissing(refusal)) gone() else refusedAt(refusal, "lstat", at)
    return removeKnown(at, folder)
  }

  // rimraf on one entry under the folder: its lstat refused but for ENOENT, it is unlinked as node unlinks it
  private fun removeEntry(path: java.nio.file.Path): MutableList<String> {
    val (refusal, folder) = kind(path)
    if (refusal != null && isMissing(refusal)) return gone()
    return removeKnown(path, refusal == null && folder)
  }

  private fun removeKnown(path: java.nio.file.Path, folder: Boolean): MutableList<String> {
    if (folder) return removeFolder(path)
    val refusal = deleteOne(path) ?: return gone()
    return if (isMissing(refusal)) gone() else refusedAt(refusal, "unlink", path)
  }

  private fun removeFolder(path: java.nio.file.Path): MutableList<String> {
    val refusal = deleteOne(path) ?: return gone()
    if (isMissing(refusal)) return gone()
    val code = codeName(refusal)
    if (code == "ENOTEMPTY" || code == "EEXIST" || code == "EPERM") return removeEntries(path)
    return refusedAt(refusal, "rmdir", path)
  }

  // the folder's entries, each removed in turn (the first refusal answered), then the folder's rmdir again
  private fun removeEntries(path: java.nio.file.Path): MutableList<String> {
    val entries: MutableList<java.nio.file.Path> =
      try {
        java.nio.file.Files.newDirectoryStream(path).use { stream -> stream.toMutableList() }
      } catch (error: kotlin.Exception) {
        return if (isMissing(error)) gone() else refusedAt(error, "scandir", path)
      }
    for (entry in entries) {
      val done = removeEntry(entry)
      if (done[0].isNotEmpty()) return done
    }
    val again = deleteOne(path) ?: return gone()
    return if (isMissing(again)) gone() else refusedAt(again, "rmdir", path)
  }
}
