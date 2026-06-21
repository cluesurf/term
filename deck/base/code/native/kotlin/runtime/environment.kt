object environment {
    fun currentDirectory(): String = System.getProperty("user.dir") ?: ""
    fun getVariable(name: String): String = System.getenv(name) ?: ""
}
