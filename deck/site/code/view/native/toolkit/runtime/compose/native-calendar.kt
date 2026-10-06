// The person's calendar under Compose on the desktop (device-layer-0024), docked by ../../calendar.tree as
// `<global:native-calendar>` and found ahead of ../native-calendar.kt (Android's). A desktop JVM reaches no calendar of
// its own, and says so.

object nativeCalendar {
    suspend fun add(title: String, start: String, end: String): String = "unavailable"

    suspend fun find(from: String, to: String): String = "unavailable"

    suspend fun remove(id: String): String = "unavailable"
}
