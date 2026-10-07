// Audio on Android (beat-term-0001), docked by ../audio.tree as `<global:native-audio>`, for both Android hosts. Not
// built yet: every task answers what a host without the capability answers (../../audio.tree), and each watcher hears
// that once, through the shared fan-out (nativeWatch). The real host, MediaPlayer segments and an AudioRecord into AAC,
// is beat-term-0011.

object nativeAudio {
    fun startLoop(path: String, segments: String, volume: Long): String = "unavailable"

    fun stopLoop(): String = "stopped"

    fun restartLoop(): String = "stopped"

    fun setLoopVolume(volume: Long): String = "${volume.coerceIn(0, 100)}"

    fun loopState(): String = "stopped"

    fun watchLoop(handler: (String) -> Unit): Int = nativeWatch.join("audio-loop", handler) { tell ->
        tell("stopped")
        {}
    }

    fun unwatchLoop(id: Int) = nativeWatch.leave("audio-loop", id)

    fun play(paths: String, volume: Long): String = "unavailable"

    fun stopPlaying(): String = "stopped"

    fun watchPlayback(handler: (String) -> Unit): Int = nativeWatch.join("audio-playback", handler) { tell ->
        tell("done")
        {}
    }

    fun unwatchPlayback(id: Int) = nativeWatch.leave("audio-playback", id)

    fun startRecording(path: String): String = "unavailable"

    fun stopRecording(): String = "idle"

    fun watchRecording(handler: (String) -> Unit): Int = nativeWatch.join("audio-recording", handler) { tell ->
        tell("idle")
        {}
    }

    fun unwatchRecording(id: Int) = nativeWatch.leave("audio-recording", id)

    fun length(path: String): String = "unavailable"
}
