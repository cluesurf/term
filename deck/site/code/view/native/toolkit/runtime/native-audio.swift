// Audio on AppKit and UIKit (beat-term-0001), docked by ../audio.tree as `<global:native-audio>`.
//
// THE LOOP is an AVAudioPlayerNode on an AVAudioEngine, each segment of the file scheduled after the one before
// (`scheduleSegment`), so the segments play back to back with no gap, and two whole rounds are kept scheduled ahead.
// When the last segment of a round has played (`.dataPlayedBack`), the loop has come back to its first segment: that
// is the wrap the watchers hear, and the round after the next is scheduled then. Stopping or restarting bumps a
// generation, and a callback from an older one is ignored, since stopping a node calls every pending callback at once.
// A 100 ms poll of the play position, which the original app used, overran every boundary by up to 100 ms.
//
// A FILE AT A TIME is an AVAudioPlayer, the next path of the queue started when the one before finishes.
//
// THE MICROPHONE is an AVAudioRecorder writing AAC into an .m4a, metered, its grant AVFoundation's (`.audio`,
// native-capture.swift), which this registers with nativePermission so permission-status(microphone) answers in an
// app that links audio and not the microphone module. Without the grant it answers the grant's status and never
// prompts: asking is request-permission's, the one place that does.
//
// ONE SESSION for all three on iOS: play and record, out of the loud speaker rather than the earpiece (which play and
// record otherwise picks), and to Bluetooth speakers as A2DP, so in a car the loop plays on the car's speakers while
// the phone's microphone records. Everything here runs on the main thread (nativeWatch.enter), where the watchers
// deliver.

import AVFoundation
import Foundation

// the microphone's grant, brought by audio as by the microphone module (native-permission.swift), run when the
// program starts
nativePermission.register("microphone", declaration: "NSMicrophoneUsageDescription", status: { nativeCapture.status(.audio) }, request: { await nativeCapture.request(.audio) })

enum nativeAudio {
    // the loop
    static func startLoop(_ path: String, _ segments: String, _ volume: Int) -> String {
        nativeWatch.enter { AudioLoop.shared.start(path: path, segments: segments, volume: volume) }
    }

    static func stopLoop() -> String {
        nativeWatch.enter { AudioLoop.shared.stop() }
    }

    static func restartLoop() -> String {
        nativeWatch.enter { AudioLoop.shared.restart() }
    }

    static func setLoopVolume(_ volume: Int) -> String {
        nativeWatch.enter { AudioLoop.shared.level(volume) }
    }

    static func loopState() -> String {
        nativeWatch.enter { AudioLoop.shared.state() }
    }

    static func watchLoop(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("audio-loop", handler) { tell in
                AudioLoop.shared.tell = tell
                tell(AudioLoop.shared.playing ? "looping" : "stopped")
                return { AudioLoop.shared.tell = nil }
            }
        }
    }

    static func unwatchLoop(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("audio-loop", id) }
    }

    // a file at a time
    static func play(_ paths: String, _ volume: Int) -> String {
        nativeWatch.enter { AudioPlayback.shared.play(paths.split(separator: "\n").map(String.init), volume: volume) }
    }

    static func stopPlaying() -> String {
        nativeWatch.enter { AudioPlayback.shared.stop() }
    }

    static func watchPlayback(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("audio-playback", handler) { tell in
                AudioPlayback.shared.tell = tell
                return { AudioPlayback.shared.tell = nil }
            }
        }
    }

    static func unwatchPlayback(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("audio-playback", id) }
    }

    // the microphone
    static func startRecording(_ path: String) -> String {
        nativeWatch.enter { AudioRecording.shared.start(path) }
    }

    static func stopRecording() -> String {
        nativeWatch.enter { AudioRecording.shared.stop() }
    }

    static func watchRecording(_ handler: @escaping (String) -> Void) -> Int {
        nativeWatch.enter {
            nativeWatch.join("audio-recording", handler) { tell in
                AudioRecording.shared.tell = tell
                if !AudioRecording.shared.recording {
                    tell("idle")
                }
                return { AudioRecording.shared.tell = nil }
            }
        }
    }

    static func unwatchRecording(_ id: Int) {
        nativeWatch.enter { nativeWatch.leave("audio-recording", id) }
    }

    // a file's length in milliseconds, read from its own frames
    static func length(_ path: String) -> String {
        guard let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else { return "unavailable" }
        return String(Int((Double(file.length) / file.processingFormat.sampleRate * 1000).rounded()))
    }

    // the one session the loop, the player and the recorder share (see the head of this file). macOS has none
    static func prepareSession() {
        #if canImport(UIKit)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP])
        try? session.setActive(true)
        #endif
    }

    // a whole percent as the gain AVFoundation takes
    static func gain(_ volume: Int) -> Float {
        Float(max(0, min(100, volume))) / 100
    }
}

// the loop: one engine, one player node, the segments of one file
@MainActor
final class AudioLoop {
    static let shared = AudioLoop()

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var file: AVAudioFile?
    private var spans: [(start: AVAudioFramePosition, count: AVAudioFrameCount)] = []
    // bumped by every start, stop and restart, so a callback of an older schedule is known for what it is
    private var generation = 0
    private var wraps = 0
    private(set) var playing = false
    var tell: ((String) -> Void)?

    init() {
        engine.attach(node)
        #if canImport(UIKit)
        // a phone call or a navigation voice takes the session: the loop stops, and says so, rather than going silent
        // while answering `looping`
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { note in
            let began = (note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init) == .began
            if began {
                MainActor.assumeIsolated { _ = AudioLoop.shared.stop() }
            }
        }
        #endif
    }

    func start(path: String, segments: String, volume: Int) -> String {
        guard FileManager.default.fileExists(atPath: path), let file = try? AVAudioFile(forReading: URL(fileURLWithPath: path)) else {
            return "unavailable"
        }
        let rate = file.processingFormat.sampleRate
        let spans: [(start: AVAudioFramePosition, count: AVAudioFrameCount)] = segments.split(separator: " ").compactMap { word in
            let ends = word.split(separator: "-").compactMap { Double($0) }
            guard ends.count == 2 else { return nil }
            let first = AVAudioFramePosition(ends[0] / 1000 * rate)
            let last = min(AVAudioFramePosition(ends[1] / 1000 * rate), file.length)
            guard first >= 0, last > first else { return nil }
            return (first, AVAudioFrameCount(last - first))
        }
        guard !spans.isEmpty else { return "invalid" }

        silence()
        nativeAudio.prepareSession()
        // the node is connected in the file's own format, which may differ from the last file's
        if engine.isRunning {
            engine.stop()
        }
        engine.disconnectNodeOutput(node)
        engine.connect(node, to: engine.mainMixerNode, format: file.processingFormat)
        node.volume = nativeAudio.gain(volume)
        do {
            try engine.start()
        } catch {
            return "failed"
        }
        self.file = file
        self.spans = spans
        wraps = 0
        begin()
        return "looping"
    }

    func stop() -> String {
        let was = playing
        silence()
        if was {
            tell?("stopped")
        }
        return "stopped"
    }

    func restart() -> String {
        guard playing else { return "stopped" }
        generation += 1
        node.stop()
        begin()
        return "looping"
    }

    func level(_ volume: Int) -> String {
        node.volume = nativeAudio.gain(volume)
        return String(Int((node.volume * 100).rounded()))
    }

    // the segment the node is playing and the place in the file, read from the node's own render clock
    func state() -> String {
        guard playing, let file, let rendered = node.lastRenderTime, let time = node.playerTime(forNodeTime: rendered) else {
            return "stopped"
        }
        let round = spans.reduce(AVAudioFramePosition(0)) { $0 + AVAudioFramePosition($1.count) }
        var into = max(0, time.sampleTime) % max(1, round)
        for (index, span) in spans.enumerated() {
            if into < AVAudioFramePosition(span.count) {
                let ms = Double(span.start + into) / file.processingFormat.sampleRate * 1000
                return "looping \(index) \(Int(ms.rounded()))"
            }
            into -= AVAudioFramePosition(span.count)
        }
        return "looping 0 0"
    }

    // two rounds scheduled, and the node playing from the first segment's start
    private func begin() {
        generation += 1
        schedule()
        schedule()
        node.play()
        if !playing {
            playing = true
            tell?("looping")
        }
    }

    private func silence() {
        generation += 1
        node.stop()
        playing = false
    }

    private func schedule() {
        guard let file else { return }
        let round = generation
        for (index, span) in spans.enumerated() {
            let last = index == spans.count - 1
            node.scheduleSegment(file, startingFrame: span.start, frameCount: span.count, at: nil, completionCallbackType: .dataPlayedBack) { _ in
                guard last else { return }
                Task { @MainActor in AudioLoop.shared.played(round) }
            }
        }
    }

    // a round has played to its end, so the next round is starting at the first segment
    private func played(_ round: Int) {
        guard round == generation, playing else { return }
        wraps += 1
        tell?("wrap \(wraps)")
        schedule()
    }
}

// one file at a time, the rest of the queue after it
@MainActor
final class AudioPlayback: NSObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayback()

    private var player: AVAudioPlayer?
    private var queue: [String] = []
    private var gain: Float = 1
    var tell: ((String) -> Void)?

    func play(_ paths: [String], volume: Int) -> String {
        guard !paths.isEmpty, paths.allSatisfy({ FileManager.default.fileExists(atPath: $0) }) else { return "unavailable" }
        player?.stop()
        player = nil
        queue = paths
        gain = nativeAudio.gain(volume)
        nativeAudio.prepareSession()
        return next() ? "playing" : "failed"
    }

    func stop() -> String {
        let was = player != nil
        player?.stop()
        player = nil
        queue = []
        if was {
            tell?("done")
        }
        return "stopped"
    }

    // the next path of the queue, playing; false when none is left or it will not play
    private func next() -> Bool {
        while !queue.isEmpty {
            let path = queue.removeFirst()
            guard let player = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: path)) else { continue }
            player.delegate = self
            player.volume = gain
            guard player.play() else { continue }
            self.player = player
            tell?("playing \(path)")
            return true
        }
        return false
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in AudioPlayback.shared.finished() }
    }

    private func finished() {
        guard player != nil else { return }
        if !next() {
            player = nil
            tell?("done")
        }
    }
}

// the microphone into one file at a time, metered
@MainActor
final class AudioRecording {
    static let shared = AudioRecording()

    private var recorder: AVAudioRecorder?
    private var path = ""
    private var ticker: Timer?
    var tell: ((String) -> Void)?

    var recording: Bool { recorder?.isRecording == true }

    // AAC, mono, 44.1 kHz, in an .m4a: small enough to share, and what every phone and DAW opens
    private var settings: [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: 44_100,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        ]
    }

    func start(_ path: String) -> String {
        guard AVCaptureDevice.default(for: .audio) != nil else { return "unavailable" }
        let grant = nativeCapture.status(.audio)
        guard grant == "granted" else { return grant == "restricted" ? "denied" : grant }
        if recording {
            return "recording"
        }
        nativeAudio.prepareSession()
        let url = URL(fileURLWithPath: path)
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard let recorder = try? AVAudioRecorder(url: url, settings: settings) else { return "failed" }
        recorder.isMeteringEnabled = true
        guard recorder.record() else { return "failed" }
        self.recorder = recorder
        self.path = path
        // ten times a second, the length so far and the level, for a clock and a meter
        ticker = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
            MainActor.assumeIsolated { AudioRecording.shared.tick() }
        }
        return "recording"
    }

    func stop() -> String {
        guard let recorder, recorder.isRecording else { return "idle" }
        let ms = Int((recorder.currentTime * 1000).rounded())
        recorder.stop()
        self.recorder = nil
        ticker?.invalidate()
        ticker = nil
        tell?("idle")
        return "audio \(ms) \(path)"
    }

    private func tick() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        // dBFS from -60 (the meter's floor) to 0, as the original's meter
        let level = max(0, min(1, (recorder.averagePower(forChannel: 0) + 60) / 60))
        tell?("recording \(Int((recorder.currentTime * 1000).rounded())) \(String(format: "%.2f", level))")
    }
}
