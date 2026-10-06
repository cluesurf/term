// The person's calendar on Android (device-layer-0024), docked by ../calendar.tree as `<global:native-calendar>`, for
// both Android hosts. The CalendarContract provider: an event goes into the first calendar the app may write, and on a
// device with none (an emulator with no account) into a local calendar of the app's own, made once through the
// provider's sync adapter door with ACCOUNT_TYPE_LOCAL, which needs no account. Events are found through Instances,
// the provider's table of occurrences, so a repeating event is answered once for each time it falls in the span, as
// EventKit answers it. Times are read as ISO 8601 with their offset and answered in UTC to the second
// (../../../calendar.tree). Without the grant every task answers the grant's status and never prompts.

import android.content.ContentUris
import android.content.ContentValues
import android.provider.CalendarContract

object nativeCalendar {
    // the name of the local calendar this makes when the device has none it can write
    private const val LOCAL = "Term"

    // `added <id>`, or invalid, not-determined, denied, unavailable or failed
    suspend fun add(title: String, start: String, end: String): String {
        refusal()?.let { return it }
        val from = read(start) ?: return "invalid"
        val to = read(end) ?: return "invalid"
        if (to < from) return "invalid"
        val activity = hostActivity() ?: return "unavailable"
        return try {
            val calendar = writable() ?: return "failed"
            val values = ContentValues().apply {
                put(CalendarContract.Events.CALENDAR_ID, calendar)
                put(CalendarContract.Events.TITLE, plain(title))
                put(CalendarContract.Events.DTSTART, from)
                put(CalendarContract.Events.DTEND, to)
                put(CalendarContract.Events.EVENT_TIMEZONE, "UTC")
            }
            val made = activity.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: return "failed"
            "added ${ContentUris.parseId(made)}"
        } catch (e: SecurityException) {
            "denied"
        } catch (e: Exception) {
            "failed"
        }
    }

    // every event overlapping the span, `start<TAB>end<TAB>title` a line, sorted; or none, invalid, or the grant's status
    suspend fun find(from: String, to: String): String {
        refusal()?.let { return it }
        val start = read(from) ?: return "invalid"
        val end = read(to) ?: return "invalid"
        if (end < start) return "invalid"
        val activity = hostActivity() ?: return "unavailable"
        val found = mutableListOf<Triple<String, String, String>>()
        try {
            val columns = arrayOf(CalendarContract.Instances.BEGIN, CalendarContract.Instances.END, CalendarContract.Instances.TITLE)
            CalendarContract.Instances.query(activity.contentResolver, columns, start, end)?.use { row ->
                while (row.moveToNext()) {
                    // Instances also holds what only touches the span at an end. An event overlaps when it begins
                    // before the span ends and ends after it begins, or, with no length, begins inside it
                    val begin = row.getLong(0)
                    val finish = row.getLong(1)
                    if (begin >= end || finish <= start && begin < start) continue
                    found.add(Triple(write(begin), write(finish), plain(row.getString(2) ?: "")))
                }
            }
        } catch (e: SecurityException) {
            return "denied"
        } catch (e: Exception) {
            return "failed"
        }
        if (found.isEmpty()) return "none"
        return found.sortedWith(compareBy<Triple<String, String, String>> { it.first }.thenBy { it.third })
            .joinToString("\n") { "${it.first}\t${it.second}\t${it.third}" }
    }

    // removed, absent, or the grant's status
    suspend fun remove(id: String): String {
        refusal()?.let { return it }
        val activity = hostActivity() ?: return "unavailable"
        val number = id.toLongOrNull() ?: return "absent"
        return try {
            val gone = activity.contentResolver.delete(ContentUris.withAppendedId(CalendarContract.Events.CONTENT_URI, number), null, null)
            if (gone > 0) "removed" else "absent"
        } catch (e: SecurityException) {
            "denied"
        } catch (e: Exception) {
            "failed"
        }
    }

    // the grant's status when it is not a grant
    private suspend fun refusal(): String? {
        val grant = nativePermission.status("calendar")
        return if (grant == "granted") null else grant
    }

    // the first calendar the app may add events to, else the local one it makes, its id
    private fun writable(): Long? {
        val activity = hostActivity() ?: return null
        val columns = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL)
        activity.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, columns, null, null, CalendarContract.Calendars._ID)?.use { row ->
            while (row.moveToNext()) {
                if (row.getInt(1) >= CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR) return row.getLong(0)
            }
        }
        val local = CalendarContract.Calendars.CONTENT_URI.buildUpon()
            .appendQueryParameter(CalendarContract.CALLER_IS_SYNCADAPTER, "true")
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_NAME, activity.packageName)
            .appendQueryParameter(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            .build()
        val values = ContentValues().apply {
            put(CalendarContract.Calendars.ACCOUNT_NAME, activity.packageName)
            put(CalendarContract.Calendars.ACCOUNT_TYPE, CalendarContract.ACCOUNT_TYPE_LOCAL)
            put(CalendarContract.Calendars.NAME, LOCAL)
            put(CalendarContract.Calendars.CALENDAR_DISPLAY_NAME, LOCAL)
            put(CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL, CalendarContract.Calendars.CAL_ACCESS_OWNER)
            put(CalendarContract.Calendars.OWNER_ACCOUNT, activity.packageName)
            put(CalendarContract.Calendars.CALENDAR_TIME_ZONE, "UTC")
            put(CalendarContract.Calendars.VISIBLE, 1)
            put(CalendarContract.Calendars.SYNC_EVENTS, 1)
        }
        return activity.contentResolver.insert(local, values)?.let { ContentUris.parseId(it) }
    }

    // ISO 8601 with its offset, to milliseconds since 1970
    private fun read(text: String): Long? =
        runCatching { java.time.OffsetDateTime.parse(text).toInstant().toEpochMilli() }.getOrNull()

    // UTC, to the second: `2030-01-01T09:00:00Z`, which sorts as text in time order
    private fun write(milliseconds: Long): String =
        java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss'Z'").withZone(java.time.ZoneOffset.UTC)
            .format(java.time.Instant.ofEpochMilli(milliseconds))

    // a tab or a line break would split the answer's lines, so each is read as a space
    private fun plain(text: String): String = text.map { if (it == '\t' || it == '\n' || it == '\r') ' ' else it }.joinToString("")
}
