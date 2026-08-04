// Torch (camera light) runtime. AVFoundation requires the device to be locked for configuration before the torch mode
// can be set and unlocked afterwards, and the mode is an enum rather than a string. Both are handled here so the seed
// source sees plain calls. Reached only through the public light API.
import AVFoundation

enum light {
    static func level(_ device: AVCaptureDevice) -> Double {
        Double(device.torchLevel)
    }

    static func has(_ device: AVCaptureDevice) -> Bool {
        device.hasTorch
    }

    static func available(_ device: AVCaptureDevice) -> Bool {
        device.isTorchAvailable
    }

    static func active(_ device: AVCaptureDevice) -> Bool {
        device.isTorchActive
    }

    // `mode` is one of "auto", "on", "off"; returns whether the change was applied
    static func setMode(_ device: AVCaptureDevice, _ mode: String) -> Bool {
        guard device.hasTorch else { return false }

        do {
            try device.lockForConfiguration()
        } catch {
            return false
        }

        switch mode {
        case "auto": device.torchMode = .auto
        case "on": device.torchMode = .on
        default: device.torchMode = .off
        }

        device.unlockForConfiguration()

        return true
    }
}
