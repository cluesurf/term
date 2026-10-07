// A download on every Kotlin host (beat-term-0004), docked by ../download.tree as `<global:native-download>`: java.net
// alone, so the same file serves Android and Compose on the desktop. The body is streamed to a file beside the path,
// renamed over it only after a 2xx answer, so a failed download leaves what was there. Read on a thread of its own,
// since a connection blocks; a minute without a byte gives up.

import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeDownload {
    // `downloaded <bytes>`, `failed <status>`, or `failed 0` with no answer
    suspend fun fetch(address: String, path: String): String = suspendCoroutine { continuation ->
        Thread { continuation.resume(blocking(address, path)) }.apply { name = "term-download" }.start()
    }

    private fun blocking(address: String, path: String): String {
        val url = runCatching { java.net.URI(address).toURL() }.getOrNull() ?: return "failed 0"
        if (url.protocol != "http" && url.protocol != "https") return "failed 0"
        val connection = runCatching { url.openConnection() as java.net.HttpURLConnection }.getOrNull() ?: return "failed 0"
        connection.connectTimeout = 60_000
        connection.readTimeout = 60_000
        return try {
            val status = connection.responseCode
            if (status !in 200..299) return "failed $status"
            val target = java.io.File(path)
            target.parentFile?.mkdirs()
            val partial = java.io.File(target.parentFile, ".${target.name}.partial")
            connection.inputStream.use { input -> partial.outputStream().use { input.copyTo(it) } }
            if (!partial.renameTo(target)) {
                target.delete()
                if (!partial.renameTo(target)) return "failed 0"
            }
            "downloaded ${target.length()}"
        } catch (e: Exception) {
            "failed 0"
        } finally {
            connection.disconnect()
        }
    }
}
