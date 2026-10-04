// `term make --target compose` and `--target compose-android` (compose-target-0004): a Term app whose views are drawn by
// Compose, built with no WebView and no Android Gradle plugin. The program is compiled for the `compose` env (Compose
// Multiplatform on the desktop JVM) or `compose-android` (Jetpack Compose), both reaching the toolkit dom
// (deck/site/code/dom/native/toolkit/dom.tree), whose runtime for each env is found under its `runtime/<env>/`.
//
//   compose          kotlinc with the Compose compiler plugin into a jar, then jpackage into an app image with its own
//                    JVM, for the OS the build runs on: a `.app` on macOS, a folder with a launcher on Linux and Windows.
//                    The JVM in the package is the price of Compose on the desktop, written here rather than found later
//   compose-android  an APK from Compose's Android libraries: each `.aar` unpacked, its resources linked by aapt2 into
//                    one base APK with an R class per library, the program and the libraries dexed by d8, then aligned
//                    and signed with the debug key, as the cask's APKs are
//
// The Compose libraries come from `task/term/native/kotlin.sh` (`compose-flags`, `compose-android-files`), which
// resolves them with Gradle from deck/base/code/native/kotlin/compose/build.gradle.kts, fetching Gradle into the cache
// when none is installed. Output goes under `host/<target>/`. The tests build through these same functions
// (test/compile/shared/compose-build.ts, compose-android.ts).

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { stdlibBase } from '@term/make/code/resolve'
import { projectResolver } from '@term/call/code/make'
import { androidTools } from '@term/call/code/cask'
import { closeRun, location, openRun, report, showPath } from '@term/call/code/output'
import { kotlinc } from '@term/call/code/kotlin-worker'
import type { KotlinCompiler } from '@term/call/code/kotlin-worker'

// the toolchain script that resolves the Compose libraries, beside the repository the stdlib lives in
function toolchainScript(): string {
  const stdlib = stdlibBase()
  const script = stdlib ? join(stdlib, '../../../../../..', 'task/term/native/kotlin.sh') : ''

  if (!script || !existsSync(script)) {
    throw new Error('the Compose toolchain script task/term/native/kotlin.sh was not found beside the stdlib')
  }

  return script
}

// the same floor and target as the cask's APKs
const MINIMUM_SDK = 26
const TARGET_SDK = 36

// a command's failure as its errors, not the warnings around them
function failure(error: unknown): string {
  const said = error as { stderr?: Buffer; stdout?: Buffer }

  return errorsOf(`${String(said.stdout ?? '')}${String(said.stderr ?? '')}` || String(error))
}

// what a tool said, cut to its errors
function errorsOf(text: string): string {
  const errors = text.split('\n').filter(line => /error|e: |Exception/.test(line))

  return (errors.length > 0 ? errors.slice(0, 12).join('\n') : text.slice(-1200)).slice(0, 2400)
}

function run(command: string, args: string[], cwd?: string): void {
  execFileSync(command, args, { stdio: 'pipe', cwd, maxBuffer: 64 * 1024 * 1024 })
}

// every file under `dir` whose name ends with `suffix`
function filesUnder(dir: string, suffix: string): string[] {
  if (!existsSync(dir)) {
    return []
  }

  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)

    return statSync(full).isDirectory() ? filesUnder(full, suffix) : name.endsWith(suffix) ? [full] : []
  })
}

function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

export type ComposeBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: 'compile' | 'prelude' | 'flags' | 'build'; reason: string }
  | { form: 'built'; jar: string; classpath: string; main: string }

// compile `text` (entry file `<dir>/<name>.tree`) for Compose on the desktop JVM and build it into a jar. `root` is where
// the program's packages resolve. `compiler` is `kotlinc` unless a session holds a warm one (./kotlin-worker.ts)
export function buildCompose({
  root,
  dir,
  name,
  text,
  compiler = kotlinc,
}: {
  root: string
  dir: string
  name: string
  text: string
  compiler?: KotlinCompiler
}): ComposeBuilt {
  if (!have('kotlinc') || !have('java')) {
    return { form: 'skipped', reason: 'kotlinc or java not installed' }
  }

  // the `compose` env: the toolkit dom, Kotlin's JVM natives, and the runtime the prelude finds for it,
  // deck/site/code/dom/native/toolkit/runtime/compose/native-view.kt (the shared Compose runtime and the desktop host)
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const entry = join(dir, `${name}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(root, 'compose'), env: 'compose' })

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose', readRuntime, kotlin)

  // the Compose runtime and not the Android one: no Android class may reach a desktop build
  if (!prelude.includes('fun CxTree(') || prelude.includes('android.widget')) {
    return { form: 'failed', stage: 'prelude', reason: 'the prelude does not hold the Compose runtime alone' }
  }

  const file = join(dir, `${name}.kt`)
  writeFileSync(file, `${hoistKotlinImports([prelude, kotlin].join('\n'))}\n`)

  let classpath = ''
  let plugin = ''

  try {
    const out = execFileSync('bash', [toolchainScript(), 'compose-flags'], { encoding: 'utf8' })
    ;[classpath = '', plugin = ''] = out.trim().split('\n')
  } catch (e) {
    return { form: 'failed', stage: 'flags', reason: String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800) }
  }

  if (!classpath.includes('ui-desktop') || !plugin.endsWith('.jar')) {
    return { form: 'failed', stage: 'flags', reason: `no Compose classpath or plugin: ${plugin}` }
  }

  const jar = join(dir, `${name}.jar`)
  const built = compiler([file, '-classpath', classpath, `-Xplugin=${plugin}`, '-jvm-target', '17', '-nowarn', '-d', jar])

  if (built.status !== 0) {
    const errors = built.output.split('\n').filter(line => /error:/.test(line))

    return { form: 'failed', stage: 'build', reason: errors.slice(0, 8).join('\n') || built.output.slice(-800) }
  }

  // kotlinc names a file's top-level class after the file: `<name>.kt` holds `<Name>Kt`
  const main = `${name.charAt(0).toUpperCase()}${name.slice(1).replace(/-(\w)/g, (_, c: string) => c.toUpperCase())}Kt`

  return { form: 'built', jar, classpath, main }
}

export type ComposeAndroidBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: string; reason: string }
  | { form: 'built'; apk: string }

// compile `text` for Jetpack Compose and make a signed APK of it, `identifier` its package. `assets` are files the APK
// carries, by name, which the program reads as `asset:<name>` (an emulator cannot read the build machine's paths).
// `compiler` is `kotlinc` unless a session holds a warm one (./kotlin-worker.ts)
export function buildComposeAndroid({
  root,
  dir,
  name,
  text,
  identifier,
  assets = {},
  compiler = kotlinc,
}: {
  root: string
  dir: string
  name: string
  text: string
  identifier: string
  assets?: Record<string, string>
  compiler?: KotlinCompiler
}): ComposeAndroidBuilt {
  let tools: ReturnType<typeof androidTools>

  try {
    tools = androidTools()
  } catch (e) {
    return { form: 'skipped', reason: String((e as Error).message ?? e) }
  }

  const work = join(dir, `${name}-android`)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })

  // the `compose-android` env: Android's natives, the toolkit dom, and the runtime the prelude finds for it,
  // deck/site/code/dom/native/toolkit/runtime/compose-android/native-view.kt (the shared Compose runtime and the Android
  // host)
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const entry = join(work, `${name}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(root, 'compose-android'), env: 'compose-android' })

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose-android', readRuntime, kotlin)
  const driver = ['class TermActivity : TermComposeActivity() {', '  override fun program() { main() }', '}'].join('\n')
  const source = join(work, 'app.kt')
  writeFileSync(source, `package ${identifier}\n\n${hoistKotlinImports([prelude, kotlin, driver].join('\n'))}\n`)

  // 1. the libraries and the compiler plugin
  const script = toolchainScript()
  let files: string[]
  let plugin: string

  try {
    files = execFileSync('bash', [script, 'compose-android-files'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
    plugin = execFileSync('bash', [script, 'compose-flags'], { encoding: 'utf8' }).trim().split('\n')[1] ?? ''
  } catch (e) {
    return { form: 'failed', stage: 'libraries', reason: failure(e) }
  }

  // 2. each `.aar` unpacked: its classes and bundled jars onto the classpath, its resources compiled, its package kept
  const jars = files.filter(file => file.endsWith('.jar'))
  const flats: string[] = []
  const packages = new Set<string>()

  try {
    files
      .filter(file => file.endsWith('.aar'))
      .forEach((aar, index) => {
        const into = join(work, 'aar', String(index))
        mkdirSync(into, { recursive: true })
        run('unzip', ['-q', '-o', aar, '-d', into])
        const classes = join(into, 'classes.jar')

        if (existsSync(classes)) {
          jars.push(classes)
        }

        jars.push(...filesUnder(join(into, 'libs'), '.jar'))
        const manifest = join(into, 'AndroidManifest.xml')
        const found = existsSync(manifest) ? /package="([^"]+)"/.exec(readFileSync(manifest, 'utf8')) : null

        if (found) {
          packages.add(found[1]!)
        }

        // 3. its resources compiled, when it has any
        const res = join(into, 'res')

        if (filesUnder(res, '').length > 0) {
          const flat = join(work, 'flat', `${index}.zip`)
          mkdirSync(join(work, 'flat'), { recursive: true })
          run(join(tools.buildTools, 'aapt2'), ['compile', '--dir', res, '-o', flat])
          flats.push(flat)
        }
      })
  } catch (e) {
    return { form: 'failed', stage: 'unpack', reason: failure(e) }
  }

  // 3. one link: the app's manifest and every library's resources, an R class for the app and each library package
  const manifest = join(work, 'AndroidManifest.xml')
  writeFileSync(
    manifest,
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="${identifier}" android:versionCode="1" android:versionName="0.0.2">`,
      `  <uses-sdk android:minSdkVersion="${MINIMUM_SDK}" android:targetSdkVersion="${TARGET_SDK}" />`,
      `  <application android:label="${name}" android:theme="@android:style/Theme.Material.Light.NoActionBar">`,
      '    <activity android:name=".TermActivity" android:exported="true" android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|uiMode|fontScale|density">',
      '      <intent-filter>',
      '        <action android:name="android.intent.action.MAIN" />',
      '        <category android:name="android.intent.category.LAUNCHER" />',
      '      </intent-filter>',
      '    </activity>',
      '  </application>',
      '</manifest>',
      '',
    ].join('\n'),
  )
  const base = join(work, `${name}-base.apk`)
  const generated = join(work, 'gen')

  // the files the APK carries, in one folder aapt2 adds as the APK's assets
  const assetDir = join(work, 'assets')
  mkdirSync(assetDir, { recursive: true })

  for (const [asset, file] of Object.entries(assets)) {
    copyFileSync(file, join(assetDir, asset))
  }

  try {
    run(join(tools.buildTools, 'aapt2'), [
      'link',
      '-o',
      base,
      '-I',
      tools.platform,
      '--manifest',
      manifest,
      '-A',
      assetDir,
      '--java',
      generated,
      '--auto-add-overlay',
      ...(packages.size > 0 ? ['--extra-packages', [...packages].join(':')] : []),
      ...flats.flatMap(flat => ['-R', flat]),
    ])
  } catch (e) {
    return { form: 'failed', stage: 'resources', reason: failure(e) }
  }

  // the R classes, compiled
  const rClasses = join(work, 'r')
  const rJar = join(work, 'r.jar')

  try {
    mkdirSync(rClasses, { recursive: true })
    run('javac', ['--release', '17', '-nowarn', '-d', rClasses, ...filesUnder(generated, '.java')])
    run('jar', ['cf', rJar, '-C', rClasses, '.'])
  } catch (e) {
    return { form: 'failed', stage: 'r classes', reason: failure(e) }
  }

  // 4. the program, with the Compose plugin, against android.jar, the libraries and the R classes
  const appJar = join(work, 'app.jar')

  const compiled = compiler([
    source,
    '-classpath',
    [tools.platform, rJar, ...jars].join(':'),
    `-Xplugin=${plugin}`,
    '-jvm-target',
    '17',
    '-nowarn',
    '-Xno-param-assertions',
    '-Xno-call-assertions',
    '-Xno-receiver-assertions',
    '-d',
    appJar,
  ])

  if (compiled.status !== 0) {
    return { form: 'failed', stage: 'kotlinc', reason: errorsOf(compiled.output) }
  }

  // 5. everything dexed: d8 writes classes.dex, classes2.dex, ... as the method count needs
  const dex = join(work, 'dex')

  try {
    mkdirSync(dex, { recursive: true })
    run(join(tools.buildTools, 'd8'), ['--release', '--lib', tools.platform, '--min-api', String(MINIMUM_SDK), '--output', dex, appJar, rJar, ...jars])
  } catch (e) {
    return { form: 'failed', stage: 'd8', reason: failure(e) }
  }

  // 6. the dex files into the base APK, aligned and signed with the debug key, as the cask signs its own
  const aligned = join(work, `${name}-aligned.apk`)
  const apk = join(work, `${name}.apk`)
  const keystore = join(process.env.HOME ?? '', '.android', 'debug.keystore')

  try {
    run('zip', ['-q', '-j', base, ...filesUnder(dex, '.dex')])
    run(join(tools.buildTools, 'zipalign'), ['-f', '-p', '4', base, aligned])

    if (!existsSync(keystore)) {
      mkdirSync(join(keystore, '..'), { recursive: true })
      run('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
    }

    run(join(tools.buildTools, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--key-pass', 'pass:android', '--out', apk, aligned])
  } catch (e) {
    return { form: 'failed', stage: 'package', reason: failure(e) }
  }

  return { form: 'built', apk }
}

// a built desktop jar packaged by jpackage as an app image with its own JVM, for the OS this runs on: the jar and every
// Compose library in one input folder, `main` the class kotlinc named after the program's file. Answers the image's path
export function packageComposeDesktop({
  jar,
  classpath,
  main,
  name,
  out,
}: {
  jar: string
  classpath: string
  main: string
  name: string
  out: string
}): string {
  const input = join(out, 'input')
  rmSync(input, { recursive: true, force: true })
  mkdirSync(input, { recursive: true })
  copyFileSync(jar, join(input, basename(jar)))

  // each library under a name of its own: two Compose jars share a file name (`runtime-desktop-1.12.1.jar` is both
  // org.jetbrains.compose.runtime's redirect and androidx.compose.runtime's runtime), and copied by name alone the
  // second replaced the first, so the packaged app had no `Composer`
  classpath
    .split(':')
    .filter(Boolean)
    .forEach((library, index) => copyFileSync(library, join(input, `${String(index).padStart(3, '0')}-${basename(library)}`)))

  const image = join(out, process.platform === 'darwin' ? `${name}.app` : name)
  rmSync(image, { recursive: true, force: true })
  run('jpackage', [
    '--type',
    'app-image',
    '--input',
    input,
    '--main-jar',
    basename(jar),
    '--main-class',
    main,
    '--name',
    name,
    '--dest',
    out,
    '--java-options',
    '--enable-native-access=ALL-UNNAMED',
  ])

  return image
}

// an app folder's name as an app is named after it, and its Android package: what `make` builds and `work` launches
export function composeIdentity(root: string): { name: string; identifier: string } {
  const name = basename(root).replace(/[^A-Za-z0-9]/g, '') || 'App'

  return { name, identifier: `surf.term.${name.toLowerCase()}` }
}

// `term make --target compose|compose-android`: the app's entry (`app.tree` by default, a program with a `main` task
// that opens a root, mounts its views and runs the app) built into `host/<target>/`
//
// It prints through the terminal output library (code/output.ts): a `make` run with one `build` item for the target,
// and a closing item. A failure is THROWN, as before, so a caller (test/compile/compose-make.ts) can read the reason;
// the error is marked `expected`, so the CLI's `failRun` reports it as a ✗ item in this same run and closes it, rather
// than as a bug in Term. `failure` names a missing toolchain (`environment`, exit 3 under section 18) for a `failRun`
// that reads it; today's exits 1 either way.
export async function makeCompose(input: { root: string; target: 'compose' | 'compose-android'; entry?: string }): Promise<{ app: string }> {
  const entry = join(input.root, input.entry ?? 'app.tree')
  openRun({ verb: 'make', root: input.root, facts: [`--target ${input.target}`] })

  if (!existsSync(entry)) {
    throw refusal(`There is no app entry at ${showPath(entry, input.root)}: a Compose app is a program with a \`main\` task (--entry names another file)`, 'usage')
  }

  const { name, identifier } = composeIdentity(input.root)
  const out = join(input.root, 'host', input.target)
  const work = join(out, 'work')
  mkdirSync(work, { recursive: true })
  const text = readFileSync(entry, 'utf8')
  const started = Date.now()

  // a build that did not finish: skipped is a toolchain this machine lacks, a failed stage is a problem
  const refuse = (built: { form: 'skipped'; reason: string } | { form: 'failed'; stage: string; reason: string }): Error =>
    built.form === 'skipped' ? refusal(built.reason, 'environment') : refusal(`${built.stage}: ${built.reason}`, '')

  if (input.target === 'compose-android') {
    const built = buildComposeAndroid({ root: input.root, dir: work, name: 'app', text, identifier })

    if (built.form !== 'built') {
      throw refuse(built)
    }

    const apk = join(out, `${name}.apk`)
    copyFileSync(built.apk, apk)
    report({ glyph: 'done', verb: 'build', subject: 'compose-android', duration: Date.now() - started, fields: [location(showPath(apk, input.root))] })
    closeRun({ verdict: 'Android app built' })

    return { app: apk }
  }

  const built = buildCompose({ root: input.root, dir: work, name: 'app', text })

  if (built.form !== 'built') {
    throw refuse(built)
  }

  const app = packageComposeDesktop({ jar: built.jar, classpath: built.classpath, main: built.main, name, out })
  report({ glyph: 'done', verb: 'build', subject: 'compose', duration: Date.now() - started, fields: [location(showPath(app, input.root))] })
  closeRun({ verdict: 'Desktop app built' })

  return { app }
}

// an error a person can act on, not a bug in Term: `expected` keeps failRun from treating it as a crash (exit 70)
function refusal(message: string, failure: string): Error {
  return Object.assign(new Error(message), { expected: true, failure })
}
