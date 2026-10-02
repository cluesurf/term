object random {
    fun number(): Long = 0
    fun integer(low: Long, high: Long): Long = (low..high).random()
}
