// AVFoundation's capture grants on AppKit and UIKit (device-layer-0001), docked as `<global:native-capture>` by the
// capabilities that need one: the camera and the torch read `.video`, the microphone `.audio`, which AVFoundation keeps
// apart. Each of those registers its grant with nativePermission through these.

import AVFoundation

enum nativeCapture {
    static func status(_ media: AVMediaType) -> String {
        switch AVCaptureDevice.authorizationStatus(for: media) {
        case .authorized: return "granted"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "not-determined"
        @unknown default: return "unavailable"
        }
    }

    static func request(_ media: AVMediaType) async -> String {
        _ = await AVCaptureDevice.requestAccess(for: media)
        return status(media)
    }
}
