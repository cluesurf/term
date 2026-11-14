// The two raising disk calls of @term/base/file/create for the kotlin target, over java.nio.file, never suspending.
// Each answers a list of text, the refusal (refusal.kt: the code name its exception stands for, empty when carried
// out, the step and the host text), which the public module raises as `failure` worded in Term (term/compiler
// decision 021 points 2, 4 and 1b).
//
// `kotlin.Exception` is spelled out: a program that loads the stdlib's `exception` form emits a class of that name
// (`Exception<P>`) beside this object, and a bare `Exception` then names it.
//
// Reached only through the public file/create API.
object fileCreate {
  // runtime-include: refusal.kt

  // createDirectory of the folder, and on a missing parent of every missing folder above it first, as node's
  // recursive mkdirSync: a folder already there is carried out (null), anything else answers the refusal of the
  // createDirectory that refused
  private fun makeAll(path: java.nio.file.Path): Throwable? {
    try {
      java.nio.file.Files.createDirectory(path)
      return null
    } catch (there: java.nio.file.FileAlreadyExistsException) {
      return if (java.nio.file.Files.isDirectory(path)) null else there
    } catch (missing: java.nio.file.NoSuchFileException) {
      val parent = path.parent ?: return missing
      val above = makeAll(parent)
      if (above != null) return above
      return try {
        java.nio.file.Files.createDirectory(path)
        null
      } catch (there: java.nio.file.FileAlreadyExistsException) {
        if (java.nio.file.Files.isDirectory(path)) null else there
      } catch (error: kotlin.Exception) {
        error
      }
    } catch (error: kotlin.Exception) {
      return error
    }
  }

  // node names the path given whichever folder of the chain refused, so the step alone crosses
  fun makeFolderPath(path: String): MutableList<String> {
    val refusal =
      try {
        makeAll(java.nio.file.Paths.get(path))
      } catch (error: kotlin.Exception) {
        error
      }

    return if (refusal == null) carried() else refused(refusal, "mkdir")
  }

  // a channel opened with CREATE_NEW (node's `wx`, O_CREAT with O_EXCL) is the `open` step, and the writes the `write`
  // step
  fun writeNewPath(path: String, body: String): MutableList<String> {
    val channel =
      try {
        java.nio.file.Files.newByteChannel(
          java.nio.file.Paths.get(path),
          java.nio.file.StandardOpenOption.CREATE_NEW,
          java.nio.file.StandardOpenOption.WRITE,
        )
      } catch (error: kotlin.Exception) {
        return refused(error, "open")
      }

    return try {
      channel.use { open ->
        val buffer = java.nio.ByteBuffer.wrap(body.toByteArray(Charsets.UTF_8))
        while (buffer.hasRemaining()) open.write(buffer)
      }
      carried()
    } catch (error: kotlin.Exception) {
      refused(error, "write")
    }
  }
}
