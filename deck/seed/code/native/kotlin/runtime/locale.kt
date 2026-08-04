// Locale runtime. Reached only through the public environment API.
object locale {
    fun tag(): String = java.util.Locale.getDefault().toLanguageTag()

    fun timezone(): String = java.util.TimeZone.getDefault().id

    fun preferred(): List<String> = listOf(tag())
}
