// The person's contacts on Android (device-layer-0023), docked by ../contacts.tree as `<global:native-contacts>`, for
// both Android hosts. Every contact's display name is read from the ContactsContract provider and matched here, by the
// contract's own rule (../../../contacts.tree): the name holding the query once both are lowercased. The provider's
// own LIKE is not used, since Apple's search matches differently. Then the phone numbers of the ones that match, by
// contact id, each number once. Sorted by name with String.compareTo, UTF-16 code units, as the Swift host sorts.
// Without the grant this answers the grant's status and never prompts (nativePermission, docked beside this).

import android.provider.ContactsContract

object nativeContacts {
    // the matching contacts, one a line, `name<TAB>number, number`; or none, not-determined, denied, unavailable, failed
    suspend fun find(query: String): String {
        val grant = nativePermission.status("contacts")
        if (grant != "granted") return grant
        val activity = hostActivity() ?: return "unavailable"
        val wanted = query.lowercase()
        val names = linkedMapOf<Long, String>()
        val numbers = mutableMapOf<Long, MutableList<String>>()
        try {
            val people = arrayOf(ContactsContract.Contacts._ID, ContactsContract.Contacts.DISPLAY_NAME_PRIMARY)
            activity.contentResolver.query(ContactsContract.Contacts.CONTENT_URI, people, null, null, null)?.use { row ->
                while (row.moveToNext()) {
                    val name = plain(row.getString(1) ?: "")
                    if (wanted.isEmpty() || name.lowercase().contains(wanted)) names[row.getLong(0)] = name
                }
            }
            if (names.isEmpty()) return "none"
            val phones = arrayOf(ContactsContract.CommonDataKinds.Phone.CONTACT_ID, ContactsContract.CommonDataKinds.Phone.NUMBER)
            activity.contentResolver.query(ContactsContract.CommonDataKinds.Phone.CONTENT_URI, phones, null, null, null)?.use { row ->
                while (row.moveToNext()) {
                    val id = row.getLong(0)
                    val number = plain(row.getString(1) ?: continue)
                    if (id in names) numbers.getOrPut(id) { mutableListOf() }.apply { if (number !in this) add(number) }
                }
            }
        } catch (e: SecurityException) {
            return "denied"
        } catch (e: Exception) {
            return "failed"
        }
        return names.entries.sortedWith { a, b -> a.value.compareTo(b.value) }
            .joinToString("\n") { "${it.value}\t${numbers[it.key].orEmpty().joinToString(", ")}" }
    }

    // a tab or a line break would split the answer's lines, so each is read as a space
    private fun plain(text: String): String = text.map { if (it == '\t' || it == '\n' || it == '\r') ' ' else it }.joinToString("")
}
