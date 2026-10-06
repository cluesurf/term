// The microphone on Android (device-layer-0022), docked by ../microphone.tree as `<global:native-microphone>`, for both
// Android hosts. One recording through AudioRecord, the platform's own API: 16-bit PCM, mono, at 16,000 samples a
// second, read on a thread of its own until the seconds asked are full, then written to the app's cache as a WAV, the
// one format every host writes. MediaRecorder is not used because none of its output formats is a WAV. Without the
// grant this answers the grant's status and never prompts (nativePermission, docked beside this).

import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeMicrophone {
    // the one format every host writes (../../../microphone.tree): samples a second, and two bytes a sample
    private const val RATE = 16_000
    private const val WIDTH = 2

    // `audio <path>`, or not-determined, denied, unavailable or failed
    suspend fun record(seconds: Long): String {
        val grant = nativePermission.status("microphone")
        if (grant != "granted") return grant
        val activity = hostActivity() ?: return "unavailable"
        if (!activity.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)) return "unavailable"
        // the app's external cache, which the person's file manager and `adb` can reach, else its private cache
        val file = File(activity.externalCacheDir ?: activity.cacheDir, "term-audio-${System.currentTimeMillis()}.wav")
        // AudioRecord.read blocks until its buffer fills, so the recording is a thread's, never the caller's
        return suspendCoroutine { continuation ->
            Thread { continuation.resume(capture(seconds.toInt(), file)) }.apply { name = "term-microphone" }.start()
        }
    }

    private fun capture(seconds: Int, file: File): String {
        val minimum = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT)
        if (minimum <= 0) return "unavailable"
        val recorder = try {
            AudioRecord(MediaRecorder.AudioSource.MIC, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, RATE * WIDTH))
        } catch (e: SecurityException) {
            return "denied"
        } catch (e: Exception) {
            return "failed"
        }
        val samples = ByteArray(RATE * WIDTH * seconds)
        var filled = 0
        try {
            if (recorder.state != AudioRecord.STATE_INITIALIZED) return "failed"
            recorder.startRecording()
            while (filled < samples.size) {
                val read = recorder.read(samples, filled, samples.size - filled)
                if (read <= 0) break
                filled += read
            }
        } catch (e: Exception) {
            return "failed"
        } finally {
            runCatching { recorder.stop() }
            recorder.release()
        }
        if (filled < samples.size) return "failed"
        return if (runCatching { file.writeBytes(wave(samples)) }.isSuccess) "audio ${file.path}" else "failed"
    }

    // the samples behind a WAV header: RIFF, a PCM `fmt ` chunk, and the `data` chunk, every number little-endian
    private fun wave(samples: ByteArray): ByteArray {
        val out = java.nio.ByteBuffer.allocate(44 + samples.size).order(java.nio.ByteOrder.LITTLE_ENDIAN)
        out.put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + samples.size).put("WAVE".toByteArray(Charsets.US_ASCII))
        out.put("fmt ".toByteArray(Charsets.US_ASCII)).putInt(16).putShort(1).putShort(1).putInt(RATE).putInt(RATE * WIDTH)
        out.putShort(WIDTH.toShort()).putShort((WIDTH * 8).toShort())
        out.put("data".toByteArray(Charsets.US_ASCII)).putInt(samples.size).put(samples)
        return out.array()
    }
}
