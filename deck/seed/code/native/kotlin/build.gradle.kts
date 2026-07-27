// Base libraries the Seed stdlib's kotlin/JVM target wraps. java.security (MessageDigest, Mac), kotlin.text.Regex,
// java.net.http.HttpClient, and java.io.File are JDK builtins. The only external base dependency is a JSON parser
// (the JDK has none): org.json. (ktor / kotlinx.serialization are added only for the richer server / typed-json paths.)
plugins { kotlin("jvm") version "2.0.0" }
repositories { mavenCentral() }
dependencies {
    implementation("org.json:json:20240303")
}
kotlin { jvmToolchain(17) }
