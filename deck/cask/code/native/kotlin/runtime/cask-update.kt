// Over-the-air page updates on Android (native-dom-0023): the client half, the twin of the Apple one
// (../../swift/runtime/cask-update.swift), which documents the order a launch runs in. The publisher is
// deck/call/code/update.ts. Reached through ../cask.tree as `caskUpdate.launchPath`, `caskUpdate.check`,
// `caskUpdate.ready`.
//
// Two things differ from Apple, both because Android ships the app as an APK:
//
//   - the runtime version and the public key are read from the APK's own assets, never from a copy of them. The
//     cask's `bundle-path` copies assets into the files directory once, and a copy made by an older install would
//     answer an older runtime version after the app itself was updated
//   - the shipped page is the asset directory `page`, so the path for it is that name, which `load-bundle` loads as an
//     asset. A downloaded update is a directory on disk, an absolute path, which `load-bundle` loads as a file
//
// Nothing here trusts the network: a manifest is used only after its exact bytes verify (SHA256withRSA) against the key
// inside the APK, and an asset only after its sha256 equals the one the signed manifest names.
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.io.File
import java.net.URL
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.Signature
import java.security.spec.X509EncodedKeySpec
import java.util.Base64
import org.json.JSONArray
import org.json.JSONObject

private val updateMain = Handler(Looper.getMainLooper())

object caskUpdate {
    private fun asset(name: String): ByteArray? =
        try {
            cask.activity?.assets?.open(name)?.use { it.readBytes() }
        } catch (_: kotlin.Exception) {
            null
        }

    private fun embeddedVersion(): String = asset("runtime-version")?.toString(Charsets.UTF_8)?.trim() ?: ""

    private fun updates(data: String): File = File(data, "updates")

    private fun read(file: File): String? = if (file.exists()) file.readText().trim() else null

    private fun bad(data: String): Set<String> = (read(File(updates(data), "bad")) ?: "").split("\n").filter { it.isNotEmpty() }.toSet()

    private fun markBad(data: String, id: String) {
        val file = File(updates(data), "bad")
        file.writeText((bad(data) + id).joinToString("\n"))
    }

    // the page to load: `page`, the shipped asset directory, or the newest downloaded update that matches this binary
    // and has not failed a launch. `resources` is the Apple runtime's; Android reads its own APK. Records which update
    // this launch runs, so a crash before `ready` is known about at the next launch
    fun launchPath(resources: String, page: String, data: String): String {
        val root = updates(data)
        root.mkdirs()
        val launching = File(root, "launching")

        read(launching)?.takeIf { it.isNotEmpty() }?.let { failed ->
            markBad(data, failed)
            if (read(File(root, "current")) == failed) File(root, "current").delete()
            launching.delete()
        }

        val id = read(File(root, "current"))?.takeIf { it.isNotEmpty() && it !in bad(data) } ?: return page
        val dir = File(root, id)
        if (read(File(dir, ".runtime-version")) != embeddedVersion() || !File(dir, "index.html").exists()) return page
        launching.writeText(id)
        return dir.path
    }

    // the first render happened: whatever this launch ran is good
    fun ready(data: String) {
        File(updates(data), "launching").delete()
    }

    // `sig=":<base64>:", keyid="root", alg="rsa-v1_5-sha256"`, the form the publisher writes
    private fun signature(header: String): ByteArray? {
        val start = header.indexOf("sig=\":")
        if (start < 0) return null
        val end = header.indexOf(":\"", start + 6)
        if (end < 0) return null
        return try {
            Base64.getDecoder().decode(header.substring(start + 6, end))
        } catch (_: kotlin.Exception) {
            null
        }
    }

    private fun verified(manifest: ByteArray, header: String): Boolean {
        val der = asset("update-key.spki.der") ?: return false
        val sig = signature(header) ?: return false
        return try {
            val key = KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(der))
            Signature.getInstance("SHA256withRSA").run {
                initVerify(key)
                update(manifest)
                verify(sig)
            }
        } catch (_: kotlin.Exception) {
            false
        }
    }

    // base64url sha256, the manifest's encoding
    private fun hash(bytes: ByteArray): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(bytes))

    private fun fetch(url: String): ByteArray? =
        try {
            URL(url).openStream().use { it.readBytes() }
        } catch (_: kotlin.Exception) {
            null
        }

    // fetch, check and stage the newest update off the main thread, then call `done` ON THE MAIN THREAD with `none`,
    // `current`, `applied <id>` or `refused: <reason>`. Never touches the page that is running
    fun check(resources: String, data: String, base: String, channel: String, done: (String) -> Unit) {
        Thread {
            val status = apply(data, base, channel)
            if (System.getenv("CASK_TRACE") != null) Log.i("cask", "cask update: $status")
            updateMain.post { done(status) }
        }.start()
    }

    private fun apply(data: String, base: String, channel: String): String {
        val version = embeddedVersion()
        if (version.isEmpty()) return "refused: no runtime version in the app"
        val root = if (base.endsWith("/")) base else "$base/"
        val manifestUrl = "${root}android/$version/$channel.json"
        val manifest = fetch(manifestUrl) ?: return "none"
        val header = fetch("$manifestUrl.sig")?.toString(Charsets.UTF_8) ?: return "refused: the signature does not verify"
        if (!verified(manifest, header)) return "refused: the signature does not verify"
        val json = try {
            JSONObject(manifest.toString(Charsets.UTF_8))
        } catch (_: kotlin.Exception) {
            return "refused: not a manifest"
        }
        val id = json.optString("id")
        if (id.isEmpty()) return "refused: not a manifest"
        if (json.optString("runtimeVersion") != version) return "refused: built for another runtime version"
        val store = updates(data)
        if (id in bad(data)) return "refused: $id failed a launch"
        if (read(File(store, "current")) == id) return "current"

        // staged under a name no launch reads, swapped in only once every asset is there and checks
        val staging = File(store, ".staging-$id")
        staging.deleteRecursively()
        val assets = mutableListOf(json.getJSONObject("launchAsset"))
        val rest: JSONArray = json.optJSONArray("assets") ?: JSONArray()
        for (index in 0 until rest.length()) assets.add(rest.getJSONObject(index))
        for (asset in assets) {
            val key = asset.optString("key")
            val path = asset.optString("url")
            val want = asset.optString("hash")
            if (key.isEmpty() || key.contains("..") || key.startsWith("/")) return "refused: an asset could not be fetched"
            val bytes = fetch(root + path) ?: return "refused: an asset could not be fetched"
            if (hash(bytes) != want) return "refused: $key does not match its hash"
            val target = File(staging, key)
            target.parentFile?.mkdirs()
            target.writeBytes(bytes)
        }
        File(staging, ".runtime-version").writeText(version)
        val final = File(store, id)
        final.deleteRecursively()
        if (!staging.renameTo(final)) return "refused: the update could not be moved into place"
        File(store, "current").writeText(id)
        return "applied $id"
    }
}
