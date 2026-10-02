// Asynchronous filesystem runtime for the kotlin target: java.nio.file and java.nio.channels, run on
// `Dispatchers.IO` through kotlinx-coroutines.
//
// WHY A DISPATCHER AND NOT A CHANNEL. The JVM's one genuinely asynchronous filesystem type,
// AsynchronousFileChannel, covers plain files and nothing else: no directory walk, no metadata, no symlink, no
// permission, no watch. Half this surface would have to be blocking anyway, and a surface that is asynchronous in
// half its calls is worse than one that is honest. `withContext(Dispatchers.IO)` on a pool that grows for blocked
// threads is what the kotlin ecosystem does for filesystem work, and it is what Ktor itself does.
//
// So `suspend` here means the caller's coroutine is not blocked, which is the promise the Term API makes. It does
// not mean the kernel is doing the waiting, which is what tokio::fs and NIOFileSystem give the other two targets.
// That difference is named in note/term/stdlib/native-async-file-and-server.md rather than papered over.
//
// TOTAL, LIKE THE REST OF THE NATIVE SURFACE: a failure reads as the empty / false / zero answer, except a handle
// open, where a missing file cannot be papered over.
//
// Reached only through the public file API.
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.Path
import java.nio.file.Paths
import java.nio.file.StandardCopyOption
import java.nio.file.StandardOpenOption
import java.nio.file.attribute.PosixFilePermissions
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

object aio {
  // An open file: the channel plus the cursor. A class, not a data holder, because the emitted `file` record is a
  // value and two copies of it must be two views of ONE open file rather than two cursors.
  class Handle(val channel: FileChannel, var at: Long)

  // A read stream: the channel, where it is, and how much of the window is left (null for "to the end").
  class Reader(val channel: FileChannel, var at: Long, var left: Long?)

  class Writer(val channel: FileChannel, var at: Long)

  private fun at(path: String): Path = Paths.get(path)

  // ---- whole file ----

  suspend fun fileRead(path: String): String = withContext(Dispatchers.IO) {
    try {
      Files.readString(at(path))
    } catch (error: Exception) {
      ""
    }
  }

  suspend fun fileReadBytes(path: String): ByteArray = withContext(Dispatchers.IO) {
    try {
      Files.readAllBytes(at(path))
    } catch (error: Exception) {
      ByteArray(0)
    }
  }

  suspend fun fileWrite(path: String, data: String) {
    fileWriteBytes(path, data.toByteArray(Charsets.UTF_8))
  }

  suspend fun fileWriteBytes(path: String, data: ByteArray) {
    withContext(Dispatchers.IO) {
      try {
        Files.write(at(path), data)
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun fileAppend(path: String, data: String) {
    withContext(Dispatchers.IO) {
      try {
        Files.write(
          at(path),
          data.toByteArray(Charsets.UTF_8),
          StandardOpenOption.CREATE,
          StandardOpenOption.APPEND,
        )
      } catch (error: Exception) {
        null
      }
    }
  }

  // `deep` copies a directory tree; without it this is the single-file copy node's copyFile means
  suspend fun fileCopy(from: String, to: String, deep: Boolean) {
    withContext(Dispatchers.IO) {
      try {
        if (deep) {
          copyTree(at(from), at(to))
        } else {
          Files.copy(at(from), at(to), StandardCopyOption.REPLACE_EXISTING)
        }
      } catch (error: Exception) {
        null
      }
    }
  }

  private fun copyTree(from: Path, to: Path) {
    if (!Files.isDirectory(from)) {
      Files.copy(from, to, StandardCopyOption.REPLACE_EXISTING)

      return
    }

    Files.createDirectories(to)
    Files.newDirectoryStream(from).use { entries ->
      for (entry in entries) {
        copyTree(entry, to.resolve(entry.fileName))
      }
    }
  }

  suspend fun fileMove(from: String, to: String) {
    withContext(Dispatchers.IO) {
      try {
        Files.move(at(from), at(to), StandardCopyOption.REPLACE_EXISTING)
      } catch (error: Exception) {
        null
      }
    }
  }

  // `deep` removes a directory tree. Without it a directory is still removed when empty, so `remove` means the
  // same thing on a file and on a directory, the way node's `rm` does.
  suspend fun fileRemove(path: String, deep: Boolean) {
    withContext(Dispatchers.IO) {
      try {
        if (deep) {
          removeTree(at(path))
        } else {
          Files.deleteIfExists(at(path))
        }
      } catch (error: Exception) {
        null
      }
    }
  }

  private fun removeTree(path: Path) {
    if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
      Files.newDirectoryStream(path).use { entries ->
        for (entry in entries) {
          removeTree(entry)
        }
      }
    }

    Files.deleteIfExists(path)
  }

  // an empty `kind` asks only whether the path exists; "file", "directory" and "link" ask what it is
  suspend fun fileTest(path: String, kind: String): Boolean = withContext(Dispatchers.IO) {
    try {
      when (kind) {
        "" -> Files.exists(at(path))
        "file" -> Files.isRegularFile(at(path))
        "directory" -> Files.isDirectory(at(path))
        "link" -> Files.isSymbolicLink(at(path))
        else -> Files.exists(at(path))
      }
    } catch (error: Exception) {
      false
    }
  }

  // ---- link ----

  suspend fun linkMake(from: String, to: String, hard: Boolean) {
    withContext(Dispatchers.IO) {
      try {
        if (hard) {
          Files.createLink(at(to), at(from))
        } else {
          Files.createSymbolicLink(at(to), at(from))
        }
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun linkRead(path: String): String = withContext(Dispatchers.IO) {
    try {
      Files.readSymbolicLink(at(path)).toString()
    } catch (error: Exception) {
      ""
    }
  }

  // ---- permission and owner ----

  // the raw unix mode, the same number chmod takes, rebuilt from the POSIX permission set the JVM reports
  suspend fun permissionRead(path: String): Long = withContext(Dispatchers.IO) {
    try {
      var mode = 0L

      for (one in Files.getPosixFilePermissions(at(path))) {
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

      mode
    } catch (error: Exception) {
      0L
    }
  }

  suspend fun permissionWrite(path: String, mode: Long) {
    withContext(Dispatchers.IO) {
      try {
        // the low nine bits as the octal string PosixFilePermissions parses
        val octal = java.lang.Long.toOctalString(mode and 0x1ffL).padStart(3, '0')
        Files.setPosixFilePermissions(
          at(path),
          PosixFilePermissions.fromString(octalToText(octal)),
        )
      } catch (error: Exception) {
        null
      }
    }
  }

  private fun octalToText(octal: String): String {
    val bits = arrayOf("---", "--x", "-w-", "-wx", "r--", "r-x", "rw-", "rwx")
    val out = StringBuilder()

    for (digit in octal) {
      out.append(bits[digit - '0'])
    }

    return out.toString()
  }

  suspend fun ownerUser(path: String): Long = withContext(Dispatchers.IO) {
    try {
      (Files.getAttribute(at(path), "unix:uid") as Number).toLong()
    } catch (error: Exception) {
      0L
    }
  }

  suspend fun ownerGroup(path: String): Long = withContext(Dispatchers.IO) {
    try {
      (Files.getAttribute(at(path), "unix:gid") as Number).toLong()
    } catch (error: Exception) {
      0L
    }
  }

  suspend fun ownerWrite(path: String, user: Long, group: Long) {
    withContext(Dispatchers.IO) {
      try {
        Files.setAttribute(at(path), "unix:uid", user.toInt())
        Files.setAttribute(at(path), "unix:gid", group.toInt())
      } catch (error: Exception) {
        null
      }
    }
  }

  // ---- temporary ----

  suspend fun temporaryMake(kind: String, prefix: String, suffix: String): String =
    withContext(Dispatchers.IO) {
      try {
        if (kind == "directory") {
          Files.createTempDirectory(prefix).toString()
        } else {
          Files.createTempFile(prefix, suffix).toString()
        }
      } catch (error: Exception) {
        ""
      }
    }

  // ---- handle ----

  suspend fun handleOpen(
    path: String,
    read: Boolean,
    write: Boolean,
    create: Boolean,
    append: Boolean,
    clear: Boolean,
  ): Handle = withContext(Dispatchers.IO) {
    val options = mutableSetOf<StandardOpenOption>()

    if (read) options.add(StandardOpenOption.READ)
    if (write || append) options.add(StandardOpenOption.WRITE)
    if (create) options.add(StandardOpenOption.CREATE)
    if (clear && !append) options.add(StandardOpenOption.TRUNCATE_EXISTING)
    if (options.isEmpty()) options.add(StandardOpenOption.READ)

    val channel = FileChannel.open(at(path), options)
    // appending starts at the end, everything else at the start, which is what the open flags mean elsewhere
    Handle(channel, if (append) channel.size() else 0L)
  }

  suspend fun handleClose(file: Handle) {
    withContext(Dispatchers.IO) {
      try {
        file.channel.close()
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun handleRead(file: Handle, size: Long): String = withContext(Dispatchers.IO) {
    if (size <= 0L) return@withContext ""

    try {
      val buffer = java.nio.ByteBuffer.allocate(size.toInt())
      val count = file.channel.read(buffer, file.at)

      if (count <= 0) return@withContext ""

      file.at += count.toLong()
      String(buffer.array(), 0, count, Charsets.UTF_8)
    } catch (error: Exception) {
      ""
    }
  }

  suspend fun handleWrite(file: Handle, data: String): Long = withContext(Dispatchers.IO) {
    try {
      val bytes = data.toByteArray(Charsets.UTF_8)
      val count = file.channel.write(java.nio.ByteBuffer.wrap(bytes), file.at)
      file.at += count.toLong()
      count.toLong()
    } catch (error: Exception) {
      0L
    }
  }

  // `frame` is "start" (absolute), "relative" (from the cursor) or "end" (back from the end)
  suspend fun handleSeek(file: Handle, offset: Long, frame: String) {
    withContext(Dispatchers.IO) {
      try {
        file.at =
          when (frame) {
            "relative" -> file.at + offset
            "end" -> file.channel.size() - offset
            else -> maxOf(0L, offset)
          }
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun handleFlush(file: Handle) {
    withContext(Dispatchers.IO) {
      try {
        file.channel.force(false)
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun handleClear(file: Handle, size: Long) {
    withContext(Dispatchers.IO) {
      try {
        file.channel.truncate(maxOf(0L, size))
        file.at = minOf(file.at, maxOf(0L, size))
      } catch (error: Exception) {
        null
      }
    }
  }

  // ---- streams ----

  suspend fun readerOpen(path: String, start: Long, size: Long): Reader =
    withContext(Dispatchers.IO) {
      val channel = FileChannel.open(at(path), setOf(StandardOpenOption.READ))
      Reader(channel, maxOf(0L, start), if (size > 0L) size else null)
    }

  // the next chunk, or the empty text at the end of the stream (or of the window)
  suspend fun readerNext(stream: Reader): String = withContext(Dispatchers.IO) {
    val left = stream.left

    if (left != null && left <= 0L) return@withContext ""

    val want = if (left != null) minOf(left, 65536L) else 65536L

    try {
      val buffer = java.nio.ByteBuffer.allocate(want.toInt())
      val count = stream.channel.read(buffer, stream.at)

      if (count <= 0) return@withContext ""

      stream.at += count.toLong()

      if (left != null) {
        stream.left = left - count.toLong()
      }

      String(buffer.array(), 0, count, Charsets.UTF_8)
    } catch (error: Exception) {
      ""
    }
  }

  suspend fun readerClose(stream: Reader) {
    withContext(Dispatchers.IO) {
      try {
        stream.channel.close()
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun writerOpen(path: String, append: Boolean): Writer = withContext(Dispatchers.IO) {
    val options = mutableSetOf(StandardOpenOption.WRITE, StandardOpenOption.CREATE)

    if (!append) options.add(StandardOpenOption.TRUNCATE_EXISTING)

    val channel = FileChannel.open(at(path), options)
    Writer(channel, if (append) channel.size() else 0L)
  }

  suspend fun writerPush(stream: Writer, data: String) {
    withContext(Dispatchers.IO) {
      try {
        val bytes = data.toByteArray(Charsets.UTF_8)
        val count = stream.channel.write(java.nio.ByteBuffer.wrap(bytes), stream.at)
        stream.at += count.toLong()
      } catch (error: Exception) {
        null
      }
    }
  }

  suspend fun writerClose(stream: Writer) {
    withContext(Dispatchers.IO) {
      try {
        stream.channel.close()
      } catch (error: Exception) {
        null
      }
    }
  }
}
