// The person's contacts under Compose on the desktop (device-layer-0023), docked by ../../contacts.tree as
// `<global:native-contacts>` and found ahead of ../native-contacts.kt (Android's). A desktop JVM reaches no address
// book of its own, and says so.

object nativeContacts {
    suspend fun find(query: String): String = "unavailable"
}
