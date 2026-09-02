// Synchronous file handles for the kotlin target, over java.io.RandomAccessFile, which is the JDK type that has a
// cursor. The asynchronous side is java.nio on Dispatchers.IO; this is the same operations with nothing to
// suspend, for the places that cannot wait or should not.
//
// Reached only through the public file/synchronous API.
import java.io.RandomAccessFile

object grip {
  class Grip(val file: RandomAccessFile)

  fun gripOpen(
    path: String,
    read: Boolean,
    write: Boolean,
    create: Boolean,
    append: Boolean,
    clear: Boolean,
  ): Grip {
    val at = java.io.File(path)

    if (create && !at.exists()) {
      at.createNewFile()
    }

    // "rw" is the only writable mode RandomAccessFile has; read-only is "r"
    val file = RandomAccessFile(at, if (write || append || clear) "rw" else "r")

    if (clear && !append) {
      file.setLength(0L)
    }

    if (append) {
      file.seek(file.length())
    }

    return Grip(file)
  }

  fun gripClose(file: Grip) {
    try {
      file.file.close()
    } catch (error: Exception) {
      Unit
    }
  }

  fun gripRead(file: Grip, size: Long): String {
    if (size <= 0L) return ""

    return try {
      val buffer = ByteArray(size.toInt())
      val count = file.file.read(buffer)

      if (count <= 0) "" else String(buffer, 0, count, Charsets.UTF_8)
    } catch (error: Exception) {
      ""
    }
  }

  fun gripWrite(file: Grip, data: String): Long =
    try {
      val bytes = data.toByteArray(Charsets.UTF_8)
      file.file.write(bytes)
      bytes.size.toLong()
    } catch (error: Exception) {
      0L
    }

  fun gripSeek(file: Grip, offset: Long, frame: String) {
    try {
      val at =
        when (frame) {
          "relative" -> file.file.filePointer + offset
          "end" -> file.file.length() - offset
          else -> maxOf(0L, offset)
        }
      file.file.seek(maxOf(0L, at))
    } catch (error: Exception) {
      Unit
    }
  }

  fun gripFlush(file: Grip) {
    try {
      file.file.fd.sync()
    } catch (error: Exception) {
      Unit
    }
  }

  fun gripClear(file: Grip, size: Long) {
    try {
      file.file.setLength(maxOf(0L, size))

      if (file.file.filePointer > size) {
        file.file.seek(maxOf(0L, size))
      }
    } catch (error: Exception) {
      Unit
    }
  }
}
