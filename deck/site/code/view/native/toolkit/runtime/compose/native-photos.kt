// The person's photo library under Compose on the desktop (device-layer-0025), docked by ../../photos.tree as
// `<global:native-photos>` and found ahead of ../native-photos.kt (Android's). A desktop JVM reaches no photo library
// of its own, and says so.

object nativePhotos {
    suspend fun newest(count: Long): String = "unavailable"

    suspend fun export(id: String): String = "unavailable"
}
