// The torch on Android (device-layer-0002), docked by ../torch.tree as `<global:native-torch>`, for both Android hosts.
// CameraManager.setTorchMode on the first camera with a flash unit, which needs no camera grant. The state is the
// platform's, heard through a torch callback (another app can turn the light off), and a device with no flash unit
// answers `unavailable`.

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Handler
import android.os.Looper

object nativeTorch {
    // the torch's state as the platform last said it, by camera
    private val lit = mutableMapOf<String, Boolean>()
    private var listening = false

    private fun manager(): CameraManager? = hostActivity()?.getSystemService(Context.CAMERA_SERVICE) as? CameraManager

    // the camera with a flash unit, if any: the back one first
    private fun torchCamera(manager: CameraManager): String? {
        val flashing = manager.cameraIdList.filter {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
        }
        return flashing.firstOrNull {
            manager.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
        } ?: flashing.firstOrNull()
    }

    private fun listen(manager: CameraManager) {
        if (listening) return
        listening = true
        manager.registerTorchCallback(object : CameraManager.TorchCallback() {
            override fun onTorchModeChanged(cameraId: String, enabled: Boolean) {
                lit[cameraId] = enabled
            }
        }, Handler(Looper.getMainLooper()))
    }

    // on, off or unavailable
    suspend fun state(): String {
        val manager = manager() ?: return "unavailable"
        val camera = torchCamera(manager) ?: return "unavailable"
        listen(manager)
        return if (lit[camera] == true) "on" else "off"
    }

    // the state after, or unavailable, or denied when another app holds the camera
    suspend fun set(state: String): String {
        val manager = manager() ?: return "unavailable"
        val camera = torchCamera(manager) ?: return "unavailable"
        listen(manager)
        return try {
            manager.setTorchMode(camera, state == "on")
            lit[camera] = state == "on"
            if (state == "on") "on" else "off"
        } catch (e: android.hardware.camera2.CameraAccessException) {
            "denied"
        }
    }
}
