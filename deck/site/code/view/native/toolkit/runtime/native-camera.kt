// The camera on Android (device-layer-0003), docked by ../camera.tree as `<global:native-camera>`, for both Android
// hosts. One photo through Camera2, the platform's own API (no CameraX, so no Gradle): the back camera opened, an
// ImageReader for one JPEG at a moderate size, one still capture, the bytes written to the app's cache, the camera
// closed. Every callback runs on a thread of its own, and the answer is given once. Without the grant this answers the
// grant's status and never prompts (nativePermission, docked beside this).

import android.content.Context
import android.graphics.ImageFormat
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.media.ImageReader
import android.os.Handler
import android.os.HandlerThread
import java.io.File
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine

object nativeCamera {
    // the widest JPEG this takes: a photo, not a sensor's full resolution
    private const val WIDEST = 1920

    // `photo <path>`, or not-determined, denied, unavailable or failed
    suspend fun capture(): String {
        val grant = nativePermission.status("camera")
        if (grant != "granted") return grant
        val activity = hostActivity() ?: return "unavailable"
        val manager = activity.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        val ids = manager.cameraIdList
        if (ids.isEmpty()) return "unavailable"
        val id = ids.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: ids.first()
        val sizes = manager.getCameraCharacteristics(id).get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
            ?.getOutputSizes(ImageFormat.JPEG).orEmpty()
        val size = sizes.filter { it.width <= WIDEST }.maxByOrNull { it.width * it.height } ?: sizes.minByOrNull { it.width * it.height }
            ?: return "failed"
        // the app's external cache, which the person's file manager and `adb` can reach, else its private cache
        val file = File(activity.externalCacheDir ?: activity.cacheDir, "term-photo-${System.currentTimeMillis()}.jpg")
        return Shot(manager, id, size.width, size.height, file).take()
    }
}

// one capture, its camera, session and reader closed whatever happens
private class Shot(val manager: CameraManager, val id: String, val width: Int, val height: Int, val file: File) {
    private val thread = HandlerThread("term-camera").apply { start() }
    private val handler = Handler(thread.looper)
    private val reader = ImageReader.newInstance(width, height, ImageFormat.JPEG, 1)
    private var camera: CameraDevice? = null
    private var answered = false

    suspend fun take(): String = suspendCoroutine { continuation ->
        // Unit, not the Boolean `handler.post` answers: the camera callbacks below return what this returns
        val finish: (String) -> Unit = { text ->
            handler.post {
                if (!answered) {
                    answered = true
                    runCatching { camera?.close() }
                    reader.close()
                    thread.quitSafely()
                    continuation.resume(text)
                }
            }
        }
        reader.setOnImageAvailableListener({ ready ->
            val image = ready.acquireLatestImage() ?: return@setOnImageAvailableListener finish("failed")
            val buffer = image.planes[0].buffer
            val bytes = ByteArray(buffer.remaining()).also { buffer.get(it) }
            image.close()
            finish(if (runCatching { file.writeBytes(bytes) }.isSuccess) "photo ${file.path}" else "failed")
        }, handler)
        try {
            manager.openCamera(id, object : CameraDevice.StateCallback() {
                override fun onOpened(device: CameraDevice) {
                    camera = device
                    session(device, finish)
                }

                override fun onDisconnected(device: CameraDevice) = finish("failed")

                override fun onError(device: CameraDevice, error: Int) =
                    finish(if (error == ERROR_CAMERA_DISABLED || error == ERROR_CAMERA_IN_USE) "denied" else "failed")
            }, handler)
        } catch (e: SecurityException) {
            finish("denied")
        } catch (e: Exception) {
            finish("failed")
        }
    }

    @Suppress("DEPRECATION")
    private fun session(device: CameraDevice, finish: (String) -> Unit) {
        try {
            device.createCaptureSession(listOf(reader.surface), object : CameraCaptureSession.StateCallback() {
                override fun onConfigured(session: CameraCaptureSession) {
                    val request = device.createCaptureRequest(CameraDevice.TEMPLATE_STILL_CAPTURE).apply { addTarget(reader.surface) }
                    session.capture(request.build(), null, handler)
                }

                override fun onConfigureFailed(session: CameraCaptureSession) = finish("failed")
            }, handler)
        } catch (e: Exception) {
            finish("failed")
        }
    }
}
