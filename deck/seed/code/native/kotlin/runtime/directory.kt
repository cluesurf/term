// Working directory runtime. Reached only through the public environment API.
//
// The JVM has no real chdir: `user.dir` is read at startup and setting it only affects code that resolves relative
// paths through it. That limitation is the platform's, and it is kept here rather than surfacing in the seed source.
object directory {
    fun get(): String = System.getProperty("user.dir") ?: ""

    fun set(path: String) {
        System.setProperty("user.dir", path)
    }
}
