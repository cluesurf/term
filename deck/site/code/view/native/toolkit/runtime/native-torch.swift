// The torch on AppKit and UIKit (device-layer-0002), docked by ../torch.tree as `<global:native-torch>`. The back
// camera's light through AVCaptureDevice, which must be locked for configuration to change. A Mac and the iOS
// simulator have no torch, and answer `unavailable`.

import AVFoundation
import Foundation

// the light is the camera's, so the torch brings the camera's grant too (native-permission.swift); registering it twice,
// with the camera, keeps the one answer
nativePermission.register("camera", declaration: "NSCameraUsageDescription", status: { nativeCapture.status(.video) }, request: { await nativeCapture.request(.video) })

enum nativeTorch {
    // the device with a torch, if this one has one
    private static func device() -> AVCaptureDevice? {
        guard let device = AVCaptureDevice.default(for: .video), device.hasTorch else { return nil }
        return device
    }

    // on, off or unavailable
    static func state() async -> String {
        guard let device = device() else { return "unavailable" }
        return device.torchMode == .on ? "on" : "off"
    }

    // the state after, or unavailable, or denied when the camera has not been granted
    static func set(_ state: String) async -> String {
        guard let device = device(), device.isTorchAvailable else { return "unavailable" }
        let grant = await nativePermission.status("camera")
        guard grant == "granted" else { return "denied" }
        do {
            try device.lockForConfiguration()
        } catch {
            return "denied"
        }
        if state == "on" {
            try? device.setTorchModeOn(level: AVCaptureDevice.maxAvailableTorchLevel)
        } else {
            device.torchMode = .off
        }
        device.unlockForConfiguration()
        return device.torchMode == .on ? "on" : "off"
    }
}
