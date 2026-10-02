// Clock runtime. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which is immune to the
// clock being adjusted and so is the one to measure durations with. Reached only through the public clock API.
object clock {
    fun now(): Long = System.currentTimeMillis()

    // milliseconds, as on every other backend (nanoTime alone is nanoseconds)
    fun precise(): Long = System.nanoTime() / 1_000_000L

    // what `clock/now` reads: monotonic milliseconds on every backend (note/term/stdlib/semantics.md)
    fun currentTime(): Long = precise()

    fun sleep(ms: Long) { Thread.sleep(ms) }
}
