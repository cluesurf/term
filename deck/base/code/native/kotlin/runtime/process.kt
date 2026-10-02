object process {
    fun getPlatform(): String = System.getProperty("os.name") ?: ""
    fun exitWith(code: Long) { kotlin.system.exitProcess(code.toInt()) }
}
