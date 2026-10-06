// The microphone on AppKit and UIKit (device-layer-0022), docked by ../microphone.tree as `<global:native-microphone>`.
// One recording: AVAudioRecorder writing 16-bit PCM, mono, at 16,000 samples a second, to a WAV in the temporary
// directory (the `.wav` extension is what makes it write a WAVE file), started, held for the seconds asked, stopped.
// Stopping is what finishes the file, so no delegate and no timer of the recorder's is waited on. On iOS the audio
// session is set to record first and let go after. Without the grant this answers the grant's status and never
// prompts: asking is request-permission's, the one place that does.

import AVFoundation
import Foundation

// the microphone's grant, brought by the microphone (native-permission.swift), run when the program starts
nativePermission.register("microphone", declaration: "NSMicrophoneUsageDescription", status: { nativeCapture.status(.audio) }, request: { await nativeCapture.request(.audio) })

enum nativeMicrophone {
    // the one format every host writes (../../../microphone.tree)
    private static var settings: [String: Any] {
        [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
    }

    // `audio <path>`, or not-determined, denied, unavailable or failed
    static func record(_ seconds: Int) async -> String {
        guard AVCaptureDevice.default(for: .audio) != nil else { return "unavailable" }
        let grant = await nativePermission.status("microphone")
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("term-audio-\(UUID().uuidString).wav")
        do {
            #if canImport(UIKit)
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .default)
            try session.setActive(true)
            defer { try? session.setActive(false, options: .notifyOthersOnDeactivation) }
            #endif
            let recorder = try AVAudioRecorder(url: path, settings: settings)
            guard recorder.record() else { return "failed" }
            try? await Task.sleep(nanoseconds: UInt64(seconds) * 1_000_000_000)
            recorder.stop()
        } catch {
            return "failed"
        }
        return FileManager.default.fileExists(atPath: path.path) ? "audio \(path.path)" : "failed"
    }
}
