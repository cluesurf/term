// File metadata for the kotlin target, over java.nio.file's attribute views, read on `Dispatchers.IO`. It builds
// the emitted `FileMetadata` record directly (the shim is prepended to the module that declares it, so the type is
// in scope), which is what keeps one attribute read from becoming seven. Reached only through the public
// file/metadata API.
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Paths
import java.nio.file.attribute.PosixFileAttributes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object stat {
  suspend fun metaRead(path: String, follow: Boolean): FileMetadata =
    withContext(Dispatchers.IO) {
      try {
        val at = Paths.get(path)
        val options =
          if (follow) emptyArray<LinkOption>() else arrayOf(LinkOption.NOFOLLOW_LINKS)
        val info = Files.readAttributes(at, PosixFileAttributes::class.java, *options)

        val kind =
          when {
            info.isDirectory -> "directory"
            info.isSymbolicLink -> "link"
            info.isRegularFile -> "file"
            else -> "other"
          }

        var mode = 0L

        for (one in info.permissions()) {
          mode = mode or
            when (one) {
              java.nio.file.attribute.PosixFilePermission.OWNER_READ -> 0x100L
              java.nio.file.attribute.PosixFilePermission.OWNER_WRITE -> 0x80L
              java.nio.file.attribute.PosixFilePermission.OWNER_EXECUTE -> 0x40L
              java.nio.file.attribute.PosixFilePermission.GROUP_READ -> 0x20L
              java.nio.file.attribute.PosixFilePermission.GROUP_WRITE -> 0x10L
              java.nio.file.attribute.PosixFilePermission.GROUP_EXECUTE -> 0x8L
              java.nio.file.attribute.PosixFilePermission.OTHERS_READ -> 0x4L
              java.nio.file.attribute.PosixFilePermission.OTHERS_WRITE -> 0x2L
              java.nio.file.attribute.PosixFilePermission.OTHERS_EXECUTE -> 0x1L
            }
        }

        FileMetadata(
          info.size(),
          kind,
          info.creationTime().toMillis(),
          info.lastModifiedTime().toMillis(),
          info.lastAccessTime().toMillis(),
          mode,
          info.isSymbolicLink,
        )
      } catch (error: Exception) {
        // a missing path reads as the zero record rather than throwing: the public API is total
        FileMetadata(0L, "other", 0L, 0L, 0L, 0L, false)
      }
    }
}
