object random {
    fun number(): Double = kotlin.random.Random.nextDouble()
    fun integer(low: Long, high: Long): Long = (low..high).random()
}
