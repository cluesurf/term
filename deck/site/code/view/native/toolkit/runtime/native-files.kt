// Picking a file on the Kotlin hosts (beat-term-0002), docked by ../files.tree as `<global:native-files>`. Not built
// yet: Android's picker answers through an activity result, which the hosts do not route the way they route
// permission answers (`hostPermissionAnswers`), and a desktop JVM has no picker that is the platform's. Both answer
// what a host without the capability answers.

object nativeFiles {
    suspend fun pick(kind: String): String = "unavailable"
}
