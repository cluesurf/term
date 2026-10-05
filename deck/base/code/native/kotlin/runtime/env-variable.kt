// Environment variable runtime. Reached only through the public environment API.
//
// The JVM's process environment (`System.getenv`) cannot change, so a write goes to an OVERLAY and every read asks it
// first: the system property `term.env.<NAME>` holds a value set by the program, and `term.env-removed.<NAME>` marks
// one it removed, so a variable the process started with can be removed too. Until 2026-10-04 a write went to the
// property `<NAME>`, which nothing read, so `set-variable` followed by `variable` answered the old value on Kotlin
// alone (guides: library/processes).
//
// Properties, not an object here, because three shims read the overlay and a program prepends only the shims it
// docks: `environment.kt` (`variable`), this one (`set-variable`, `has-variable`, `variables`) and `runner.kt`, which
// hands it to a child as its environment, the way a node child inherits `process.env`. Each spells out the two
// prefixes rather than calling across.
object envVariable {
    fun get(name: String): String =
        System.getProperty("term.env.$name")
            ?: if (System.getProperty("term.env-removed.$name") != null) "" else System.getenv(name) ?: ""

    fun set(name: String, value: String) {
        System.setProperty("term.env.$name", value)
        System.clearProperty("term.env-removed.$name")
    }

    fun remove(name: String) {
        System.clearProperty("term.env.$name")
        System.setProperty("term.env-removed.$name", "1")
    }

    fun list(): MutableMap<String, String> {
        val all = System.getenv().toMutableMap()
        for (key in System.getProperties().stringPropertyNames()) {
            if (key.startsWith("term.env-removed.")) {
                all.remove(key.removePrefix("term.env-removed."))
            }
        }
        for (key in System.getProperties().stringPropertyNames()) {
            if (key.startsWith("term.env.")) {
                all[key.removePrefix("term.env.")] = System.getProperty(key) ?: ""
            }
        }
        return all
    }

    fun check(name: String): Boolean =
        System.getProperty("term.env.$name") != null ||
            (System.getProperty("term.env-removed.$name") == null && System.getenv(name) != null)
}
