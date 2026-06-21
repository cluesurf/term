import java.time.Instant
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

// Calendar over java.time (built into the JDK), all in UTC. Timestamps are epoch milliseconds. The pattern matches the
// host-Date / chrono / Foundation formatting (2026-06-19T12:34:56.000Z).
object calendar {
    private val formatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC)
    private fun at(millis: Long): ZonedDateTime = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC)
    fun format(millis: Long): String = formatter.format(Instant.ofEpochMilli(millis))
    fun parse(text: String): Long = Instant.parse(text).toEpochMilli()
    fun year(millis: Long): Long = at(millis).year.toLong()
    fun month(millis: Long): Long = at(millis).monthValue.toLong()
    fun day(millis: Long): Long = at(millis).dayOfMonth.toLong()
    fun hour(millis: Long): Long = at(millis).hour.toLong()
    fun minute(millis: Long): Long = at(millis).minute.toLong()
    fun second(millis: Long): Long = at(millis).second.toLong()
    // java.time is 1=Monday..7=Sunday; the uniform interface is 0=Sunday..6=Saturday, so take it modulo 7
    fun weekday(millis: Long): Long = (at(millis).dayOfWeek.value % 7).toLong()
    fun build(year: Long, month: Long, day: Long, hour: Long, minute: Long, second: Long): Long =
        ZonedDateTime.of(year.toInt(), month.toInt(), day.toInt(), hour.toInt(), minute.toInt(), second.toInt(), 0, ZoneOffset.UTC)
            .toInstant().toEpochMilli()
    fun addMonths(millis: Long, count: Long): Long = at(millis).plusMonths(count).toInstant().toEpochMilli()
    fun addYears(millis: Long, count: Long): Long = at(millis).plusYears(count).toInstant().toEpochMilli()
}
