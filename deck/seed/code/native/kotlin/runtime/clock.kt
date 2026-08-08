// Clock runtime. `now` is the wall clock in milliseconds; `precise` is the monotonic timer, which is immune to the
// clock being adjusted and so is the one to measure durations with. Reached only through the public clock API.
object clock {
    fun now(): Long = System.currentTimeMillis()

    fun precise(): Long = System.nanoTime()

    fun currentTime(): Long = System.currentTimeMillis()

    fun sleep(ms: Long) { Thread.sleep(ms) }
}
