// Camera runtime. Authorization status and the flash mode are AVFoundation enums rather than strings, so each is
// mapped here. Reached only through the public camera API.
import AVFoundation

enum camera {
    // one of "authorized", "not-determined", "denied", "restricted"
    static func authorization() -> String {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: return "authorized"
        case .notDetermined: return "not-determined"
        case .denied: return "denied"
        default: return "restricted"
        }
    }

    static func requestAccess() async -> Bool {
        await AVCaptureDevice.requestAccess(for: .video)
    }

    static func defaultDevice() -> AVCaptureDevice {
        AVCaptureDevice.default(for: .video)!
    }

    static func hasFlash(_ device: AVCaptureDevice) -> Bool {
        device.hasFlash
    }

    // `mode` is one of "auto", "on", "off"
    static func setFlash(
        _ settings: AVCapturePhotoSettings,
        _ mode: String,
    ) {
        switch mode {
        case "auto": settings.flashMode = .auto
        case "on": settings.flashMode = .on
        default: settings.flashMode = .off
        }
    }
}
