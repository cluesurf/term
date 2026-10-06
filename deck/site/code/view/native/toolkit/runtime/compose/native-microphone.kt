// The microphone under Compose on the desktop (device-layer-0022), docked by ../../microphone.tree as
// `<global:native-microphone>` and found ahead of ../native-microphone.kt (Android's). A desktop JVM has no grant to
// ask through (../native-permission.kt answers unavailable for every one), so it records nothing, and says so, as its
// camera does.

object nativeMicrophone {
    suspend fun record(seconds: Long): String = "unavailable"
}
