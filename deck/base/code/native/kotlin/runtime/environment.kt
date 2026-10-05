// `variable` reads the program's own writes first: `term.env.<NAME>` is a value `set-variable` stored, and
// `term.env-removed.<NAME>` one `remove-variable` removed (the overlay `env-variable.kt` describes)
object environment {
    fun currentDirectory(): String = System.getProperty("user.dir") ?: ""
    fun getVariable(name: String): String =
        System.getProperty("term.env.$name")
            ?: if (System.getProperty("term.env-removed.$name") != null) "" else System.getenv(name) ?: ""
}
