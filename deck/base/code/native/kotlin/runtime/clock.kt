// Clock runtime. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which is immune to the
// clock being adjusted and so is the one to measure durations with. Reached only through the public clock API.
object clock {
    fun now(): Long = System.currentTimeMillis()

    // milliseconds, as on every other backend (nanoTime alone is nanoseconds)
    fun precise(): Long = System.nanoTime() / 1_000_000L

    // the origin of `nanoseconds`, taken at the first reading (an object's property is initialized on first use)
    private val origin: Long by lazy { System.nanoTime() }

    // whole nanoseconds since the first reading, never decreasing
    // the origin is read FIRST: a lazy value is set on its first use, so reading the time before it would make the
    // first reading earlier than its own origin
    fun nanoseconds(): Long {
        val from = origin
        return System.nanoTime() - from
    }

    // what `clock/now` reads: monotonic milliseconds on every backend (note/term/stdlib/semantics.md)
    fun currentTime(): Long = precise()

    fun sleep(ms: Long) { Thread.sleep(ms) }
}
