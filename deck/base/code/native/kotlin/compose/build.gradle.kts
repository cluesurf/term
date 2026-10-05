// The libraries a Term view needs to render as Compose (compose-target), and the ONE place their versions are written.
// Kept apart from ../pom.xml, the stdlib's own runtime, so a program that draws nothing never carries Skia.
//
// GRADLE, NOT MAVEN, unlike the rest of the kotlin target. Compose is published as Kotlin Multiplatform libraries:
// each root artifact carries Gradle module metadata that routes a JVM consumer to its `-desktop` or `-jvm` variant.
// Maven reads only the root POMs, so it pulled the Android `.aar` variants into a desktop classpath and refused the
// androidx exact version ranges ([1.11.0,1.11.0]) that Gradle settles by taking the highest. Pinning moved the
// conflict each time. Gradle reads the metadata, which is the whole difference.
//
// It resolves and builds nothing: `writeClasspath` writes the desktop runtime classpath and the Compose compiler
// plugin jar to the paths task/term/native/kotlin.sh passes, and the gate compiles with kotlinc against them.
//
//   compose.desktop          runtime, foundation, material and UI for the desktop JVM, drawn through Skia (skiko).
//                            The same composables run on Android through Jetpack Compose: one lowering, four
//                            platforms. The artifact is per platform; this one is the machine the gate runs on.
//   compose compiler plugin  rewrites @Composable functions into the runtime's calls. It ships with Kotlin, so its
//                            version is the installed kotlinc's (`kotlinc -version`). The plain artifact, not the
//                            -embeddable one: that is the build the command-line compiler loads, as -Xplugin=<jar>.

val kotlinVersion = "2.3.10"
val composeVersion = "1.12.1"
val sqliteJdbcVersion = "3.53.4.0"

// the desktop artifact for the machine resolving it, so the same file serves macOS, Linux and Windows
val hostDesktop = run {
  val os = System.getProperty("os.name").lowercase()
  val arm = System.getProperty("os.arch").let { it == "aarch64" || it == "arm64" }
  val system = when {
    os.contains("mac") -> "macos"
    os.contains("win") -> "windows"
    else -> "linux"
  }
  "$system-${if (arm) "arm64" else "x64"}"
}

// another platform's, named `<os>-<arch>` (`linux-x64`, `windows-arm64`): the libraries an app image for THAT machine
// carries (compose-target-0004). The program's own classes are the same bytecode everywhere; only Skia's native library
// differs, so a build here resolves the target's libraries and the target's own jpackage packages them
val desktopTarget = providers.gradleProperty("desktopTarget").orNull ?: hostDesktop
val desktop = "org.jetbrains.compose.desktop:desktop-jvm-$desktopTarget:$composeVersion"

plugins { java }

repositories {
  mavenCentral()
  google()
}

val compose: Configuration by configurations.creating {
  attributes {
    attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
    attribute(Attribute.of("org.jetbrains.kotlin.platform.type", String::class.java), "jvm")
  }
}

val plugin: Configuration by configurations.creating { isTransitive = false }

// Android (compose-target-0004): the same composables, as Jetpack Compose's Android builds. There is no Android Gradle
// plugin here, so the configuration asks for Android runtime variants by their published attributes, and what comes
// back is `.aar` and `.jar` files: task/term/native/kotlin.sh unpacks them, links their resources with aapt2 and dexes
// the classes, the way the APK pipeline already builds an app without Gradle.
//
// By the JVM ENVIRONMENT, not the Kotlin platform type: the Android variants of these libraries are published with
// platform type `jvm` (the Kotlin Multiplatform Android plugin's spelling), the same as the desktop ones, and what tells
// the two apart is Gradle's standard `org.gradle.jvm.environment`, `android` against `standard-jvm`
val android: Configuration by configurations.creating {
  attributes {
    attribute(Usage.USAGE_ATTRIBUTE, objects.named(Usage.JAVA_RUNTIME))
    attribute(Category.CATEGORY_ATTRIBUTE, objects.named(Category.LIBRARY))
    attribute(TargetJvmEnvironment.TARGET_JVM_ENVIRONMENT_ATTRIBUTE, objects.named(TargetJvmEnvironment.ANDROID))
  }
}

val activityComposeVersion = "1.13.0"

dependencies {
  compose("org.jetbrains.kotlin:kotlin-stdlib:$kotlinVersion")
  compose(desktop)
  compose("org.jetbrains.compose.material:material-desktop:$composeVersion")
  compose("org.jetbrains.compose.ui:ui-test-junit4-desktop:$composeVersion")
  // the desktop's SQLite (deck/site/code/base/native/kotlin/runtime/compose/sqlite.kt): JDBC, where Android has its own
  compose("org.xerial:sqlite-jdbc:$sqliteJdbcVersion")
  plugin("org.jetbrains.kotlin:kotlin-compose-compiler-plugin:$kotlinVersion")
  android("org.jetbrains.kotlin:kotlin-stdlib:$kotlinVersion")
  android("org.jetbrains.compose.material:material:$composeVersion")
  android("androidx.activity:activity-compose:$activityComposeVersion")
}

tasks.register("writeAndroid") {
  val androidOut = providers.gradleProperty("androidOut")
  doLast {
    file(androidOut.get()).writeText(android.resolve().joinToString("\n") { it.absolutePath } + "\n")
  }
}

// the desktop runtime's files for `desktopTarget`, one a line: what an app image for that platform carries beside the
// program's jar
tasks.register("writeDesktop") {
  val desktopOut = providers.gradleProperty("desktopOut")
  doLast {
    file(desktopOut.get()).writeText(compose.resolve().joinToString("\n") { it.absolutePath } + "\n")
  }
}

tasks.register("writeClasspath") {
  val classpathOut = providers.gradleProperty("classpathOut")
  val pluginOut = providers.gradleProperty("pluginOut")
  doLast {
    file(classpathOut.get()).writeText(compose.resolve().joinToString(File.pathSeparator) { it.absolutePath })
    file(pluginOut.get()).writeText(plugin.resolve().single().absolutePath + "\n")
  }
}
