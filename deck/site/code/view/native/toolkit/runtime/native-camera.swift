// The camera on AppKit and UIKit (device-layer-0003), docked by ../camera.tree as `<global:native-camera>`. One photo:
// a capture session with the default video device and a photo output, one capture, the JPEG written to the temporary
// directory. The iOS simulator has no camera, and answers `unavailable`. Without the grant this answers the grant's
// status and never prompts: asking is request-permission's, the one place that does.

import AVFoundation
import Foundation

// the camera's grant, brought by the camera (native-permission.swift), run when the program starts
nativePermission.register("camera", declaration: "NSCameraUsageDescription", status: { nativeCapture.status(.video) }, request: { await nativeCapture.request(.video) })

enum nativeCamera {
    // `photo <path>`, or not-determined, denied, unavailable or failed
    static func capture() async -> String {
        guard let device = AVCaptureDevice.default(for: .video) else { return "unavailable" }
        let grant = await nativePermission.status("camera")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        return await PhotoTaker(device: device).take()
    }
}

// one capture: the session runs on a queue of its own (starting it blocks), and the photo arrives through the
// delegate, which must live until it has. EVERYTHING it holds changes on `queue` alone, the delegate's answer hopped
// onto it, which is what makes it safe to hand between threads (`@unchecked Sendable`)
final class PhotoTaker: NSObject, AVCapturePhotoCaptureDelegate, @unchecked Sendable {
    private let device: AVCaptureDevice
    private let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private let queue = DispatchQueue(label: "term.camera")
    private var answer: CheckedContinuation<String, Never>?

    init(device: AVCaptureDevice) {
        self.device = device
    }

    func take() async -> String {
        await withCheckedContinuation { continuation in
            queue.async { [self] in
                answer = continuation
                guard let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input), session.canAddOutput(output) else {
                    return finish("failed")
                }
                session.beginConfiguration()
                session.sessionPreset = .photo
                session.addInput(input)
                session.addOutput(output)
                session.commitConfiguration()
                session.startRunning()
                output.capturePhoto(with: AVCapturePhotoSettings(format: [AVVideoCodecKey: AVVideoCodecType.jpeg]), delegate: self)
            }
        }
    }

    private func finish(_ text: String) {
        session.stopRunning()
        guard let answer else { return }
        self.answer = nil
        answer.resume(returning: text)
    }

    // AVFoundation's queue: the JPEG is written here, and the answer hopped onto `queue`
    func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        var text = "failed"
        if error == nil, let data = photo.fileDataRepresentation() {
            let path = FileManager.default.temporaryDirectory.appendingPathComponent("term-photo-\(UUID().uuidString).jpg")
            if (try? data.write(to: path)) != nil {
                text = "photo \(path.path)"
            }
        }
        queue.async { [self] in finish(text) }
    }
}
