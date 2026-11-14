  // ---- the refusal of a file call (term/compiler decision 021 points 4 and 4a) ----
  //
  // Included whole by aio.kt and blocking.kt (`// runtime-include: refusal.kt`), so each of the two objects holds its
  // own copy of this one source. A refused java.nio.file call crosses as a list of text: the POSIX code name the JVM's
  // exception stands for, the step that failed as node's `syscall` names it, and the host's own text. A call carried
  // out answers the empty code name. Term words the note (@term/base/file/failure), never this file, and no record
  // crosses: about 25 modules dock aio.

  // the POSIX code name of a refusal. The JVM has no errno: its exception class names some codes, and the reason of any
  // other, the C library's strerror text, names the rest. Anything else answers `?`, which no table row names, so the
  // note is then the host's own text
  fun codeName(error: Throwable): String {
    val reason = (if (error is java.nio.file.FileSystemException) error.reason else error.message) ?: ""

    return when {
      error is java.nio.file.NoSuchFileException -> "ENOENT"
      error is java.nio.file.NotDirectoryException -> "ENOTDIR"
      error is java.nio.file.AccessDeniedException -> "EACCES"
      error is java.nio.file.FileAlreadyExistsException -> "EEXIST"
      error is java.nio.file.DirectoryNotEmptyException -> "ENOTEMPTY"
      error is java.nio.file.FileSystemLoopException -> "ELOOP"
      reason == "Operation not permitted" -> "EPERM"
      reason == "No such file or directory" -> "ENOENT"
      reason == "Input/output error" -> "EIO"
      reason == "Permission denied" -> "EACCES"
      reason == "File exists" -> "EEXIST"
      reason == "Not a directory" -> "ENOTDIR"
      reason == "Is a directory" -> "EISDIR"
      reason == "No space left on device" -> "ENOSPC"
      reason == "Read-only file system" -> "EROFS"
      reason == "Too many links" -> "EMLINK"
      reason == "File name too long" -> "ENAMETOOLONG"
      reason == "Too many levels of symbolic links" -> "ELOOP"
      reason == "Directory not empty" -> "ENOTEMPTY"
      else -> "?"
    }
  }

  fun refused(error: Throwable, step: String): MutableList<String> =
    kotlin.collections.mutableListOf(codeName(error), step, error.message ?: error.toString())

  fun carried(): MutableList<String> = kotlin.collections.mutableListOf("", "", "")
