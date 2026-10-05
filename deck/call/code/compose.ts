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
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { CompileCache } from '@term/make/code/compile/cache'
import { collectModules } from '@term/make/code/compile/load'
import type { ParseMemo, Resolver } from '@term/make/code/compile/load'
import { checkScope } from '@term/call/code/scope'
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

// the entry file a build compiles: the app's own `file` when it has one, so its relative loads (`load ./notes`) resolve
// beside it, else `text` written into the build's folder (a test's program, which loads only packages)
function entryOf(input: { file?: string; dir: string; name: string; text: string }): string {
  if (input.file) {
    return input.file
  }

  const entry = join(input.dir, `${input.name}.tree`)
  writeFileSync(entry, input.text)

  return entry
}

// an APP build's scope (deck/call/code/scope.ts): the capabilities the program reaches, from the modules its build
// loads, each of which its `scope.tree` must name. Answers the refusal, or nothing when the program is within it. A
// test's program is no app and is built with no scope. `memo` is the session's parse memo, keyed by content, so a
// rebuild does not parse the closure twice
export type AppScope = { root: string; memo?: ParseMemo }

function refusedScope(scope: AppScope | undefined, entry: string, text: string, resolve: Resolver): string | undefined {
  if (!scope) {
    return undefined
  }

  try {
    checkScope({ root: scope.root, files: collectModules({ file: entry, text }, resolve, scope.memo).sources.map(one => one.file) })
  } catch (e) {
    return (e as Error).message
  }

  return undefined
}

// where compiled Compose runtimes are kept between builds: the native toolchain's cache (task/term/native/common.sh)
const RUNTIME_CACHE = join(process.env.TERM_NATIVE_CACHE ?? join(tmpdir(), 'term-native'), 'kotlin', 'compose-runtime')

// the program's Kotlin compiled against its RUNTIME, the prelude, which is compiled once per distinct text into a jar
// kept in RUNTIME_CACHE. The runtime is 1,700 lines that change only when the program's docks do, and the program a
// fraction of that, so an edit pays for the program alone: 2 seconds where both together were 13 (live-reload). The
// jar is written under a name of its own and then renamed, so two builds at once never read half of one. A runtime that
// does not compile on its own is compiled with the program in one file, as every build was before. `header` opens each
// file (Android's `package`); the answer names the jars the program needs beside it at run time
function compileKotlin(input: {
  compiler: KotlinCompiler
  stages: Stages
  dir: string
  name: string
  header: string
  runtime: string
  program: string
  classpath: string[]
  flags: string[]
  out: string
}): { status: number; output: string; runtimeJars: string[] } {
  const compile = (file: string, text: string, classpath: string[], out: string) => {
    writeFileSync(file, `${input.header}${hoistKotlinImports(text)}\n`)

    return input.compiler([file, '-classpath', classpath.join(':'), ...input.flags, '-d', out])
  }
  const runtime = `${input.header}${hoistKotlinImports(input.runtime)}`
  const key = createHash('sha256').update([runtime, input.classpath.join(':'), input.flags.join(' ')].join('\0')).digest('hex').slice(0, 32)
  const jar = join(RUNTIME_CACHE, `${key}.jar`)

  if (!existsSync(jar)) {
    mkdirSync(RUNTIME_CACHE, { recursive: true })
    const fresh = join(RUNTIME_CACHE, `${key}.${process.pid}.${Date.now()}.jar`)
    const built = stage(input.stages, 'runtime', () => compile(join(input.dir, `${input.name}-runtime.kt`), input.runtime, input.classpath, fresh))

    if (built.status !== 0) {
      const whole = stage(input.stages, 'kotlin', () => compile(join(input.dir, `${input.name}.kt`), [input.runtime, input.program].join('\n'), input.classpath, input.out))

      return { ...whole, runtimeJars: [] }
    }

    renameSync(fresh, jar)
  }

  const program = stage(input.stages, 'kotlin', () => compile(join(input.dir, `${input.name}.kt`), input.program, [jar, ...input.classpath], input.out))

  return { ...program, runtimeJars: [jar] }
}

// how long each stage of a build took, in order: what a person waiting on a rebuild is shown (`term work`), and what
// says where a slow build spends its time
export type Stages = [stage: string, ms: number][]

// run one stage of a build, its time recorded whether it answers or throws
function stage<T>(stages: Stages, name: string, run: () => T): T {
  const started = Date.now()

  try {
    return run()
  } finally {
    stages.push([name, Date.now() - started])
  }
}

export type ComposeBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: 'compile' | 'scope' | 'prelude' | 'flags' | 'build'; reason: string }
  // `runtimeJars` are the program's own compiled runtime (compileKotlin), which every OS's app image carries as it is,
  // beside that OS's Compose libraries
  | { form: 'built'; jar: string; classpath: string; main: string; runtimeJars: string[]; stages: Stages }

// compile `text` (entry file `<dir>/<name>.tree`) for Compose on the desktop JVM and build it into a jar. `root` is where
// the program's packages resolve; `file` is the entry's own path when the program is an app's (see entryOf). A session
// that builds again and again (`term work`) passes what it keeps warm: a
// `compiler` (./kotlin-worker.ts, else `kotlinc`) and a `cache`, the Term compiler's parsed modules, so an edit reparses
// only the files that changed
export function buildCompose({
  root,
  dir,
  name,
  text,
  file,
  compiler = kotlinc,
  cache,
  scope,
}: {
  root: string
  dir: string
  name: string
  text: string
  file?: string
  compiler?: KotlinCompiler
  cache?: CompileCache
  scope?: AppScope
}): ComposeBuilt {
  if (!have('kotlinc') || !have('java')) {
    return { form: 'skipped', reason: 'kotlinc or java not installed' }
  }

  // the `compose` env: the toolkit dom, Kotlin's JVM natives, and the runtime the prelude finds for it,
  // deck/site/code/dom/native/toolkit/runtime/compose/native-view.kt (the shared Compose runtime and the desktop host)
  const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
  const stages: Stages = []
  const entry = entryOf({ file, dir, name, text })
  const resolve = projectResolver(root, 'compose')
  const result = stage(stages, 'term', () => compile({ file: entry, text }, { resolve, env: 'compose', cache }))

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const refused = stage(stages, 'scope', () => refusedScope(scope, entry, text, resolve))

  if (refused) {
    return { form: 'failed', stage: 'scope', reason: refused }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose', readRuntime, kotlin)

  // the Compose runtime and not the Android one: no Android class may reach a desktop build
  if (!prelude.includes('fun CxTree(') || prelude.includes('android.widget')) {
    return { form: 'failed', stage: 'prelude', reason: 'the prelude does not hold the Compose runtime alone' }
  }

  let classpath = ''
  let plugin = ''

  try {
    const out = stage(stages, 'flags', () => execFileSync('bash', [toolchainScript(), 'compose-flags'], { encoding: 'utf8' }))
    ;[classpath = '', plugin = ''] = out.trim().split('\n')
  } catch (e) {
    return { form: 'failed', stage: 'flags', reason: String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 800) }
  }

  if (!classpath.includes('ui-desktop') || !plugin.endsWith('.jar')) {
    return { form: 'failed', stage: 'flags', reason: `no Compose classpath or plugin: ${plugin}` }
  }

  const jar = join(dir, `${name}.jar`)
  const built = compileKotlin({
    compiler,
    stages,
    dir,
    name,
    header: '',
    runtime: prelude,
    program: kotlin,
    classpath: classpath.split(':'),
    flags: [`-Xplugin=${plugin}`, '-jvm-target', '17', '-nowarn'],
    out: jar,
  })

  if (built.status !== 0) {
    const errors = built.output.split('\n').filter(line => /error:/.test(line))

    return { form: 'failed', stage: 'build', reason: errors.slice(0, 8).join('\n') || built.output.slice(-800) }
  }

  // kotlinc names a file's top-level class after the file, capitalized, a character no name may hold written `_`:
  // `app.kt` holds `AppKt` and `compose-linux.kt` holds `Compose_linuxKt` (it was guessed `ComposeLinuxKt`, which no
  // build found until a name had a hyphen in it)
  const main = `${name.charAt(0).toUpperCase()}${name.slice(1)}`.replace(/[^A-Za-z0-9_$]/g, '_') + 'Kt'

  // the runtime's jar first: the program is run, and packaged, with it beside the Compose libraries
  return { form: 'built', jar, classpath: [...built.runtimeJars, classpath].join(':'), main, runtimeJars: built.runtimeJars, stages }
}

export type ComposeAndroidBuilt =
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; stage: string; reason: string }
  | { form: 'built'; apk: string; stages: Stages }

// compile `text` for Jetpack Compose and make a signed APK of it, `identifier` its package. `assets` are files the APK
// carries, by name, which the program reads as `asset:<name>` (an emulator cannot read the build machine's paths).
// `compiler` and `cache` are what a session keeps warm, and `scope` is the app's, as for buildCompose
export function buildComposeAndroid({
  root,
  dir,
  name,
  text,
  identifier,
  assets = {},
  file,
  compiler = kotlinc,
  cache,
  scope,
}: {
  root: string
  dir: string
  name: string
  text: string
  identifier: string
  assets?: Record<string, string>
  file?: string
  compiler?: KotlinCompiler
  cache?: CompileCache
  scope?: AppScope
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
  const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
  const entry = entryOf({ file, dir: work, name, text })
  const resolve = projectResolver(root, 'compose-android')
  const stages: Stages = []
  const result = stage(stages, 'term', () => compile({ file: entry, text }, { resolve, env: 'compose-android', cache }))

  if (!result.ok) {
    return { form: 'failed', stage: 'compile', reason: [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | ') }
  }

  const refused = stage(stages, 'scope', () => refusedScope(scope, entry, text, resolve))

  if (refused) {
    return { form: 'failed', stage: 'scope', reason: refused }
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, 'compose-android', readRuntime, kotlin)
  const driver = ['class TermActivity : TermComposeActivity() {', '  override fun program() { main() }', '}'].join('\n')

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

  // EVERYTHING BEFORE THE PROGRAM IS KEPT, by what it is made from (live-reload). The libraries unpacked and their
  // resources compiled depend on the library set alone; the link (the base APK and the R classes) on that, the app's
  // package, label and assets; the libraries' dex on the library set. An edit changes none of them, so it pays for the
  // program alone: its Kotlin, its dex, and the zip and signature. Each is built under a name of its own and renamed
  // into place (`kept`), so two builds at once never read half of one
  let libraries: AndroidLibraries
  let linked: { base: string; rJar: string; rDex: string }
  let libraryDex: string

  try {
    libraries = stage(stages, 'unpack', () => prepareAndroidLibraries(files, tools))
  } catch (e) {
    return { form: 'failed', stage: 'unpack', reason: failure(e) }
  }

  try {
    linked = stage(stages, 'link', () => linkAndroidApp({ libraries, tools, identifier, name, assets }))
  } catch (e) {
    return { form: 'failed', stage: 'resources', reason: failure(e) }
  }

  try {
    libraryDex = stage(stages, 'library dex', () =>
      kept(join(ANDROID_CACHE, 'dex'), libraries.key, into =>
        run(join(tools.buildTools, 'd8'), ['--release', '--lib', tools.platform, '--min-api', String(MINIMUM_SDK), '--output', into, ...libraries.jars]),
      ),
    )
  } catch (e) {
    return { form: 'failed', stage: 'd8', reason: failure(e) }
  }

  // 4. the program, with the Compose plugin, against android.jar, the libraries and the R classes, its runtime kept
  const appJar = join(work, 'app.jar')
  const compiled = compileKotlin({
    compiler,
    stages,
    dir: work,
    name: 'app',
    header: `package ${identifier}\n\n`,
    runtime: prelude,
    program: [kotlin, driver].join('\n'),
    classpath: [tools.platform, linked.rJar, ...libraries.jars],
    flags: [`-Xplugin=${plugin}`, '-jvm-target', '17', '-nowarn', '-Xno-param-assertions', '-Xno-call-assertions', '-Xno-receiver-assertions'],
    out: appJar,
  })

  if (compiled.status !== 0) {
    return { form: 'failed', stage: 'kotlinc', reason: errorsOf(compiled.output) }
  }

  // 5. the program dexed, and its runtime's dex, kept beside that runtime's jar. Each against everything it calls, so
  // d8 can desugar across the boundary as one dexing of the whole did
  const d8 = (out: string, jar: string, against: string[]) =>
    run(join(tools.buildTools, 'd8'), ['--release', '--lib', tools.platform, '--min-api', String(MINIMUM_SDK), ...against.flatMap(one => ['--classpath', one]), '--output', out, jar])
  const programDex = join(work, 'dex')

  try {
    mkdirSync(programDex, { recursive: true })
    stage(stages, 'dex', () => d8(programDex, appJar, [...compiled.runtimeJars, linked.rJar, ...libraries.jars]))
  } catch (e) {
    return { form: 'failed', stage: 'd8', reason: failure(e) }
  }

  let runtimeDexes: string[]

  try {
    runtimeDexes = stage(stages, 'runtime dex', () =>
      compiled.runtimeJars.map(jar => kept(join(ANDROID_CACHE, 'runtime-dex'), `${basename(jar, '.jar')}-${libraries.key}`, into => d8(into, jar, [linked.rJar, ...libraries.jars]))),
    )
  } catch (e) {
    return { form: 'failed', stage: 'd8', reason: failure(e) }
  }

  // 6. every dex into a copy of the base APK, numbered as Android loads them (classes.dex, classes2.dex, ...), aligned and
  // signed with the debug key, as the cask signs its own
  const staged = join(work, 'staged')
  const base = join(work, `${name}-base.apk`)
  const aligned = join(work, `${name}-aligned.apk`)
  const apk = join(work, `${name}.apk`)
  const keystore = join(process.env.HOME ?? '', '.android', 'debug.keystore')

  try {
    stage(stages, 'package', () => {
      mkdirSync(staged, { recursive: true })
      const dexes = [programDex, ...runtimeDexes, linked.rDex, libraryDex].flatMap(one => dexFiles(one))
      const numbered = dexes.map((dex, index) => {
        const to = join(staged, index === 0 ? 'classes.dex' : `classes${index + 1}.dex`)
        copyFileSync(dex, to)

        return to
      })
      copyFileSync(linked.base, base)
      run('zip', ['-q', '-j', base, ...numbered])
      run(join(tools.buildTools, 'zipalign'), ['-f', '-p', '4', base, aligned])

      if (!existsSync(keystore)) {
        mkdirSync(join(keystore, '..'), { recursive: true })
        run('keytool', ['-genkeypair', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
      }

      run(join(tools.buildTools, 'apksigner'), ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--key-pass', 'pass:android', '--out', apk, aligned])
    })
  } catch (e) {
    return { form: 'failed', stage: 'package', reason: failure(e) }
  }

  return { form: 'built', apk, stages }
}

// the dex files d8 wrote into a folder, in its own order: classes.dex, then classes2.dex, classes3.dex, ...
function dexFiles(dir: string): string[] {
  const order = (file: string) => Number(/classes(\d*)\.dex$/.exec(file)?.[1] || '1')

  return filesUnder(dir, '.dex').sort((a, b) => order(a) - order(b))
}

// where the Android stages that do not change between edits are kept: beside the Compose runtimes
const ANDROID_CACHE = join(RUNTIME_CACHE, '..', 'compose-android')

// the list of every file a kept folder was made with, written into it
const KEPT = '.kept'

// whether a kept folder still holds every file it was made with. The cache is under $TMPDIR, which macOS purges FILE
// BY FILE, so a folder can survive with a file gone, and is then made again rather than trusted
function whole(dir: string): boolean {
  const list = join(dir, KEPT)

  return existsSync(list) && readFileSync(list, 'utf8').split('\n').filter(Boolean).every(one => existsSync(join(dir, one)))
}

// a folder made once per `key` and kept under `root`: made under a name of its own and renamed into place, so a build
// running beside this one never reads half of it, a stage that failed leaves nothing behind, and one that lost a file
// since is made again (`whole`). Answers its path
function kept(root: string, key: string, make: (dir: string) => void): string {
  const done = join(root, key)

  if (existsSync(done) && whole(done)) {
    return done
  }

  rmSync(done, { recursive: true, force: true })

  const fresh = join(root, `${key}.${process.pid}.${Date.now()}`)
  mkdirSync(fresh, { recursive: true })

  try {
    make(fresh)
  } catch (e) {
    rmSync(fresh, { recursive: true, force: true })
    throw e
  }

  // every file the stage made, by its path inside the folder, for `whole` to find again
  writeFileSync(join(fresh, KEPT), `${filesUnder(fresh, '').map(one => one.slice(fresh.length + 1)).join('\n')}\n`)

  try {
    renameSync(fresh, done)
  } catch {
    // another build finished the same stage first: its folder is the same, and this one goes
    rmSync(fresh, { recursive: true, force: true })
  }

  return done
}

// a key for what a stage is made from: its parts, and each FILE's size and time, so a library the toolchain replaced
// is a new key
function keyOf(parts: string[], files: string[] = []): string {
  const stamps = files.map(one => {
    const stat = statSync(one)

    return `${one}:${stat.size}:${stat.mtimeMs}`
  })

  return createHash('sha256').update([...parts, ...stamps].join('\0')).digest('hex').slice(0, 32)
}

type AndroidLibraries = { key: string; jars: string[]; flats: string[]; packages: string[] }

// 2. the libraries unpacked: each `.aar`'s classes and bundled jars onto the classpath, its resources compiled by aapt2
// and its package kept, made once per library set
function prepareAndroidLibraries(files: string[], tools: ReturnType<typeof androidTools>): AndroidLibraries {
  const key = keyOf(['libraries', tools.buildTools], files)
  const dir = kept(join(ANDROID_CACHE, 'libraries'), key, into => {
    const jars = files.filter(one => one.endsWith('.jar'))
    const flats: string[] = []
    const packages = new Set<string>()

    files
      .filter(one => one.endsWith('.aar'))
      .forEach((aar, index) => {
        const unpacked = join(into, 'aar', String(index))
        mkdirSync(unpacked, { recursive: true })
        run('unzip', ['-q', '-o', aar, '-d', unpacked])
        const classes = join(unpacked, 'classes.jar')

        if (existsSync(classes)) {
          jars.push(classes)
        }

        jars.push(...filesUnder(join(unpacked, 'libs'), '.jar'))
        const manifest = join(unpacked, 'AndroidManifest.xml')
        const found = existsSync(manifest) ? /package="([^"]+)"/.exec(readFileSync(manifest, 'utf8')) : null

        if (found) {
          packages.add(found[1]!)
        }

        // its resources compiled, when it has any
        const res = join(unpacked, 'res')

        if (filesUnder(res, '').length > 0) {
          const flat = join(into, 'flat', `${index}.zip`)
          mkdirSync(join(into, 'flat'), { recursive: true })
          run(join(tools.buildTools, 'aapt2'), ['compile', '--dir', res, '-o', flat])
          flats.push(flat)
        }
      })

    // the paths are written relative to the kept folder, which is renamed into place after this
    const inside = (one: string) => (one.startsWith(into) ? one.slice(into.length + 1) : one)
    writeFileSync(join(into, 'libraries.json'), JSON.stringify({ jars: jars.map(inside), flats: flats.map(inside), packages: [...packages] }))
  })
  const listed = JSON.parse(readFileSync(join(dir, 'libraries.json'), 'utf8')) as { jars: string[]; flats: string[]; packages: string[] }
  const at = (one: string) => (one.startsWith('/') ? one : join(dir, one))

  return { key, jars: listed.jars.map(at), flats: listed.flats.map(at), packages: listed.packages }
}

// 3. one link: the app's manifest and every library's resources, an R class for the app and each library package, the
// R classes compiled and dexed, made once per library set, package, label and assets
function linkAndroidApp(input: {
  libraries: AndroidLibraries
  tools: ReturnType<typeof androidTools>
  identifier: string
  name: string
  assets: Record<string, string>
}): { base: string; rJar: string; rDex: string } {
  const { libraries, tools, identifier, name, assets } = input
  const manifestText = [
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
  ].join('\n')
  const key = keyOf(['link', libraries.key, manifestText, ...Object.keys(assets).sort()], Object.keys(assets).sort().map(one => assets[one]!))
  const dir = kept(join(ANDROID_CACHE, 'link'), key, into => {
    const manifest = join(into, 'AndroidManifest.xml')
    writeFileSync(manifest, manifestText)

    // the files the APK carries, in one folder aapt2 adds as the APK's assets
    const assetDir = join(into, 'assets')
    mkdirSync(assetDir, { recursive: true })

    for (const [asset, from] of Object.entries(assets)) {
      copyFileSync(from, join(assetDir, asset))
    }

    const generated = join(into, 'gen')
    run(join(tools.buildTools, 'aapt2'), [
      'link',
      '-o',
      join(into, 'base.apk'),
      '-I',
      tools.platform,
      '--manifest',
      manifest,
      '-A',
      assetDir,
      '--java',
      generated,
      '--auto-add-overlay',
      ...(libraries.packages.length > 0 ? ['--extra-packages', libraries.packages.join(':')] : []),
      ...libraries.flats.flatMap(flat => ['-R', flat]),
    ])

    // the R classes, compiled and dexed
    const rClasses = join(into, 'r')
    mkdirSync(rClasses, { recursive: true })
    run('javac', ['--release', '17', '-nowarn', '-d', rClasses, ...filesUnder(generated, '.java')])
    run('jar', ['cf', join(into, 'r.jar'), '-C', rClasses, '.'])
    mkdirSync(join(into, 'r-dex'), { recursive: true })
    run(join(tools.buildTools, 'd8'), ['--release', '--lib', tools.platform, '--min-api', String(MINIMUM_SDK), '--output', join(into, 'r-dex'), join(into, 'r.jar')])
  })

  return { base: join(dir, 'base.apk'), rJar: join(dir, 'r.jar'), rDex: join(dir, 'r-dex') }
}

// jpackage's input folder for a desktop app, made at `input`: the program's jar and every library beside it. Each library
// under a name of its own: two Compose jars share a file name (`runtime-desktop-1.12.1.jar` is both
// org.jetbrains.compose.runtime's redirect and androidx.compose.runtime's runtime), and copied by name alone the second
// replaced the first, so the packaged app had no `Composer`. Shared by the image made here and one made on another
// machine for its own OS (compose-target-0004)
export function composeInput({ jar, libraries, input }: { jar: string; libraries: string[]; input: string }): void {
  rmSync(input, { recursive: true, force: true })
  mkdirSync(input, { recursive: true })
  copyFileSync(jar, join(input, basename(jar)))
  libraries.forEach((library, index) => copyFileSync(library, join(input, `${String(index).padStart(3, '0')}-${basename(library)}`)))
}

// jpackage's arguments for a desktop app image, every path as the machine that RUNS jpackage sees it: this one's, or
// another's for its own OS (jpackage builds only for the OS it runs on). `console` keeps a Windows launcher's standard
// output, which a Windows app image's launcher, a GUI program, otherwise has none of
export function jpackageArguments({
  input,
  jar,
  main,
  name,
  dest,
  console = false,
}: {
  input: string
  jar: string
  main: string
  name: string
  dest: string
  console?: boolean
}): string[] {
  return [
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
    dest,
    '--java-options',
    '--enable-native-access=ALL-UNNAMED',
    ...(console ? ['--win-console'] : []),
  ]
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
  composeInput({ jar, libraries: classpath.split(':').filter(Boolean), input })
  const image = join(out, process.platform === 'darwin' ? `${name}.app` : name)
  rmSync(image, { recursive: true, force: true })
  run('jpackage', jpackageArguments({ input, jar, main, name, dest: out }))

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
    const built = buildComposeAndroid({ root: input.root, dir: work, name: 'app', text, file: entry, identifier, scope: { root: input.root } })

    if (built.form !== 'built') {
      throw refuse(built)
    }

    const apk = join(out, `${name}.apk`)
    copyFileSync(built.apk, apk)
    report({ glyph: 'done', verb: 'build', subject: 'compose-android', duration: Date.now() - started, fields: [location(showPath(apk, input.root))] })
    closeRun({ verdict: 'Android app built' })

    return { app: apk }
  }

  const built = buildCompose({ root: input.root, dir: work, name: 'app', text, file: entry, scope: { root: input.root } })

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
