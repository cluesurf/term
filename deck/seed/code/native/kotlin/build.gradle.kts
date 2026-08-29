// Base libraries the Seed stdlib's kotlin/JVM target wraps. java.security (MessageDigest, Mac), kotlin.text.Regex,
// java.net.http.HttpClient, and java.io.File are JDK builtins. JSON is read and written by the stdlib's own shim
// (`runtime/json.kt`), so nothing external is needed for it. (ktor / kotlinx.serialization are added only for the
// richer server / typed-json paths.)
plugins { kotlin("jvm") version "2.0.0" }
repositories { mavenCentral() }
kotlin { jvmToolchain(17) }
