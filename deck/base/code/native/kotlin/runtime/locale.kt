// Locale runtime. Reached only through the public environment API.
object tongue {
    fun tag(): String = java.util.Locale.getDefault().toLanguageTag()

    fun timezone(): String = java.util.TimeZone.getDefault().id

    fun preferred(): MutableList<String> = mutableListOf(tag())
}
