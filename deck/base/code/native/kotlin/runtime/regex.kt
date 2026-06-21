object regex {
    fun matches(pattern: String, text: String): Boolean = Regex(pattern).containsMatchIn(text)
    fun replace(pattern: String, text: String, replacement: String): String = Regex(pattern).replace(text, replacement)
    fun find(pattern: String, text: String): String = Regex(pattern).find(text)?.value ?: ""
}
