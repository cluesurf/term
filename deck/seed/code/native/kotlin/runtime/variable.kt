// Environment variable runtime. Reached only through the public environment API.
//
// Note the asymmetry the JVM forces: reads come from the process environment (`System.getenv`), which is immutable
// there, so writes go to system properties instead. That is the platform's behaviour, not a choice made here, and it
// is kept in this file so the seed source sees one uniform interface.
object variable {
    fun get(name: String): String = System.getenv(name) ?: ""

    fun set(name: String, value: String) {
        System.setProperty(name, value)
    }

    fun remove(name: String) {
        System.clearProperty(name)
    }

    fun list(): Map<String, String> = System.getenv()

    fun check(name: String): Boolean = System.getenv(name) != null
}
