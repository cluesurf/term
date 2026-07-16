object clock {
    fun currentTime(): Long = System.nanoTime() / 1000000
    fun sleep(ms: Long) { Thread.sleep(ms) }
}
