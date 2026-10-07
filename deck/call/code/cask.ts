// `term make --target macos`: a Term app into a native app cask. Four steps, each a function here so the task scripts
// (task/term/cask-mac.ts, task/term/app-smoke.ts) and the CLI share one build path:
//
//   1. generate    the bridge from the page's docks: the webview shims and the app's dispatcher (cask-generate.ts)
//   2. page        the page compiled in the `webview` env, bundled by esbuild, mounted by its `boot` task
//   3. program     the cask program compiled to Swift with the cask runtime prepended, built by swiftc
//   4. bundle      the `.app` layout, ad-hoc or identity signed, and a `.dmg` when asked
//
// An app is a directory with a `deck.tree` naming it, a page entry (`face/base.tree`, a module exporting a `boot`
// task that mounts the page) and a cask entry (`cask.tree`, a module exporting `boot(bundle)` that opens the window
// and hands the process to the platform). Output goes under `host/<target>/`. Design: note/term/cask/readme.md.
//
// What the build decides without its file system or a toolchain is Term, in cask-plan.tree: the tools each target
// needs, the app's names, the cargo manifest, the driver line's labels, the device chosen and every manifest written.
// This file holds the steps around them.
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import { collectModules } from '@term/make/code/compile/load'
import { checkScope } from '@term/call/code/scope'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibBase } from '@term/make/code/resolve'
import { manifestNameOf } from '@term/call/code/manifest-name'
import { projectResolver } from '@term/call/code/make'
import { generateBridge } from '@term/call/code/cask-generate'
import { toolVersion } from '@term/call/code/show'
import { runtimeVersion, toolchainOf, type RuntimeVersion } from '@term/call/code/runtime-version'
import { publishUpdate, stampUpdateKey } from '@term/call/code/update'
import { appleUsage, permissionLines } from '@term/call/code/device-declare'
import { closeRun, count, field, followChild, isRunOpen, location, openRun, report, runTool, showPath } from '@term/call/code/output'
import * as plan from '@term/call/code/cask-plan'

export type CaskTarget = 'macos' | 'ios' | 'android' | 'linux' | 'windows'

export const CASK_TARGETS: CaskTarget[] = ['macos', 'ios', 'android', 'linux', 'windows']

// the Android platform the cask is built against and the lowest it runs on (cask-plan.tree `minimum-of` and
// `android-manifest` hold the same two)
const ANDROID_PLATFORM = 36
const ANDROID_MINIMUM = Number(plan.minimumOf('android'))

// the simulator slice iOS is built for, at the lowest iOS the cask runs on
const IOS_SIMULATOR_TARGET = `arm64-apple-ios${plan.minimumOf('ios')}-simulator`

// where a page entry and a cask entry live in an app, when the command is not told otherwise
const DEFAULT_PAGE = 'face/base.tree'
const DEFAULT_ENTRY = 'cask.tree'

// the Swift module every Apple app is built as, whatever the app is called. Left to swiftc it is the executable's name,
// and an app named after an Apple framework shadows it: built as `Photos`, the program's own `import Photos` imported
// itself and PHPhotoLibrary was not in scope (device-layer-0025). No Apple framework has this name, and nothing reads
// the module by name
export const SWIFT_MODULE = 'TermApp'

const readRuntime = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined

// The swift flags the stdlib's standard stack needs (swift-nio, Hummingbird), written by task/term/native/swift.sh
// into the native cache. Read when present; an app whose closure never reaches the asynchronous file or server
// modules builds without them. The path is the script's own convention, so the two cannot disagree.
export function swiftFlags(): string[] {
  const cache = process.env.TERM_NATIVE_CACHE ?? path.join(process.env.TMPDIR ?? tmpdir(), 'term-native')
  const file = path.join(cache, 'swift', 'flags.txt')

  if (!existsSync(file)) {
    return []
  }

  return readFileSync(file, 'utf8').split('\n').filter(line => line.length > 0)
}

// the app's name and bundle identifier from its manifest: `deck @term/blog` is `Blog` and `surf.term.blog`
export function appIdentity(root: string): { name: string; identifier: string } {
  const manifest = path.join(root, 'deck.tree')
  const declared = existsSync(manifest) ? manifestNameOf(manifest) : undefined
  const words = plan.appWordsOf(declared ?? path.basename(root))

  return { name: words.name, identifier: words.identifier }
}

// ---- the page ----

// The browser DOM runtime's anchor shim imports @floating-ui/dom, and a page that never anchors a panel still carries
// that import because the prelude keeps a shim whose name appears anywhere in the emitted code. When the package is
// not installed beside the page, the bundle gets a stub whose members raise on first use, so the app loads and a
// page that does anchor fails at the call rather than at module load. A page that has the package installed
// resolves it as usual: the stub only steps in when esbuild's own resolution finds nothing.
async function stubMissingPackages(): Promise<import('esbuild').Plugin> {
  return {
    name: 'stub-missing-packages',
    setup(api) {
      api.onResolve({ filter: /^@floating-ui\/dom$/ }, async args => {
        if (args.pluginData?.stubbing) {
          return undefined
        }
        const found = await api.resolve(args.path, {
          kind: args.kind,
          resolveDir: args.resolveDir,
          pluginData: { stubbing: true },
        })
        if (found.errors.length === 0 && found.path) {
          return { path: found.path }
        }
        return { path: args.path, namespace: 'stub' }
      })
      api.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
        contents: [
          `const missing = () => { throw new Error(${JSON.stringify(`${args.path} is not in this bundle`)}) }`,
          'export const computePosition = missing',
          'export const offset = missing',
          'export const flip = missing',
          'export const shift = missing',
          'export const autoUpdate = missing',
        ].join('\n'),
        loader: 'js',
      }))
    },
  }
}

// the page compiled in the `webview` env so every native goes over the bridge, bundled, started by `entry`: the
// line of TypeScript that calls what the page exports
export async function buildPage({
  root,
  page,
  entry,
  into,
  title,
  work,
}: {
  root: string
  page: string
  entry: string
  into: string
  title: string
  // where the intermediate TypeScript goes
  work: string
}): Promise<{ bytes: number }> {
  const result = compile(
    { file: page, text: readFileSync(page, 'utf8') },
    { resolve: projectResolver(root, 'webview'), env: 'webview' },
  )

  if (!result.ok) {
    throw refusal(
      `the page failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const prelude = nativePrelude(result.program, 'webview', readRuntime, result.typescript)
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(path.join(work, 'app.ts'), `${prelude}\n${result.typescript}`)
  writeFileSync(path.join(work, 'entry.ts'), entry)

  // esbuild is loaded here rather than at the top so `term make` without a target never pays for it
  const { build } = await import('esbuild')
  const bundled = await build({
    entryPoints: [path.join(work, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [await stubMissingPackages()],
  })

  // `write: false` answers the bundle in memory, one file for one entry
  const [script] = bundled.outputFiles

  if (!script) {
    throw new Error('esbuild answered no bundle for the page')
  }

  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'app.js'), script.text)
  writeFileSync(path.join(into, 'index.html'), plan.pageHtml(title))

  return { bytes: script.text.length }
}

// ---- the program ----

// THE DRIVER'S ARGUMENTS BY LABEL. A Swift task's inputs are labeled by name (compile/swift.ts `label`), so the line
// calling `boot` must name each one, and an entry names them itself: `bundle`, or `resources` and `base`, or `bundle`,
// `shoot` and `shot`. The labels are read off the emitted `func boot(...)`, so a driver written by position (every one
// here, from before the labels) gets the entry's own. `cask/smoke` and the update test stopped compiling on
// `missing argument labels` until this (2026-10-05). A driver that already labels, or a `boot` with none, is left
export function labelBoot(driver: string, swift: string): string {
  return plan.labelBoot(driver, swift)
}

// the cask program compiled to Swift, the cask runtime prepended, and `driver`, the top-level Swift line that
// calls the program's `boot`
export function buildProgram({
  root,
  entry,
  driver,
  exe,
  work,
  target = 'macos',
  identifier,
}: {
  root: string
  entry: string
  driver: string
  exe: string
  work: string
  target?: CaskTarget
  // the app's bundle identifier, which an iOS simulator build carries in its entitlements (below)
  identifier?: string
}): { source: string; native: string } {
  // the platform's own env, not bare `swift`: its chain (the platform, apple, toolkit, swift) reaches the toolkit host
  // a device module answers through, so a page's camera or clipboard call is answered by the platform's API in the cask
  // as in a toolkit app (device-layer-0013). Under `swift` every device module resolved to its `unavailable` fallback
  const env = target === 'ios' ? 'ios' : 'macos'
  const result = compile(
    { file: entry, text: readFileSync(entry, 'utf8') },
    { resolve: projectResolver(root, env), env },
  )

  if (!result.ok) {
    throw refusal(
      `the cask program failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, env, readRuntime, swift)
  // a `boot` that can raise is `throws` in Swift, and the top-level line calling it must say `try`: it did not, and
  // the windows cask stopped building once `file/read` raised `absence` (2026-10-04). An error reaching the top
  // level ends the program with its message, which is what a raise nothing caught means
  const line = plan.driverLine(driver, swift)
  const source = ['import Foundation', prelude, swift, line, ''].join('\n')
  const file = path.join(work, 'app.swift')
  mkdirSync(work, { recursive: true })
  writeFileSync(file, source)
  mkdirSync(path.dirname(exe), { recursive: true })

  // The release flags. `-wmo` lets generics specialize across the one module. `-enforce-exclusivity=unchecked` drops the
  // dynamic exclusivity check on every access to a class's stored property, and a Term list is a `SeedList` class:
  // on fannkuch-redux that check was about 3x of the run (2.8 to 3.7 s against 1.0 to 1.2 s, 2026-10-02). It is sound
  // for emitted Term code because the emitter never creates an overlapping access: a read of `.data` copies the array
  // value, so its access ends at once, a write is one statement, and nothing is passed `inout`. The test harnesses keep
  // the default checked build, so an overlap a later change introduces traps in the suites rather than shipping
  // (note/term/codegen/ios.md, Build)
  const release = ['-O', '-wmo', '-enforce-exclusivity=unchecked']

  if (target === 'ios') {
    // the iOS simulator SDK through xcrun. The stdlib's macOS package flags (swift-nio, Hummingbird) are not iOS
    // modules and are not passed; an app whose closure reaches them does not build for iOS yet
    const sdk = execFileSync('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    // The app's entitlements in the binary's __entitlements section, where the simulator reads them, as a simulator
    // build Xcode makes with no team carries them: its identifier and its own keychain group, under a placeholder team
    // prefix. Without them the simulator's Keychain refuses every secret (errSecMissingEntitlement, device-layer-0020).
    // In the signature instead, the simulator refuses to launch the app
    const section: string[] = []

    if (identifier) {
      const entitlements = path.join(work, 'entitlements.plist')
      writeFileSync(entitlements, plan.simulatorEntitlements(identifier))
      section.push('-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__entitlements', '-Xlinker', entitlements)
    }

    runTool('xcrun', ['-sdk', 'iphonesimulator', 'swiftc', '-target', IOS_SIMULATOR_TARGET, '-sdk', sdk, ...release, ...section, '-module-name', SWIFT_MODULE, '-o', exe, file])
  } else {
    runTool('swiftc', [...swiftFlags(), ...release, '-module-name', SWIFT_MODULE, '-o', exe, file])
  }

  // the native half as compiled, without the driver line, which differs between a dev build and a release of the
  // same binary surface. What the runtime version hashes
  return { source: file, native: [prelude, swift].join('\n') }
}

// ---- linux and windows: the Rust cask ----

// the crate name of an app: `blog` for `@term/blog`. A crate is snake_case
export function crateOf(name: string): string {
  return plan.crateOf(name)
}

// the manifest of the app's cargo project: the stdlib's own crate list (deck/base/code/native/rust/Cargo.toml) read
// at build time so the two cannot drift, plus SQLite, plus each platform's toolkit under its own `cfg`, so a
// project written on one platform checks on any other with the runtime's stub half
export function cargoManifest(crate: string, source: string): string {
  const stdlib = stdlibBase()
  const own = stdlib ? path.join(stdlib, 'code/native/rust/Cargo.toml') : undefined

  return plan.cargoManifest(crate, own && existsSync(own) ? readFileSync(own, 'utf8') : '', source)
}

// compile the cask entry for rust into a cargo project at `<work>/cargo`, and build it when this machine is the
// target's own platform. Elsewhere the project is checked with the runtime's stub half when cargo is here, which
// holds the emitted program to the runtime's signatures, and the build happens on a box of that platform
// (`pnpm term:app-smoke --target linux` ships it to the work droplet)
export function buildRustProgram({
  root,
  entry,
  driver,
  work,
  crate,
  target,
}: {
  root: string
  entry: string
  driver: string
  work: string
  crate: string
  target: CaskTarget
}): { project: string; exe?: string; native: string } {
  const result = compile(
    { file: entry, text: readFileSync(entry, 'utf8') },
    { resolve: projectResolver(root, 'rust'), env: 'rust' },
  )

  if (!result.ok) {
    throw refusal(
      `the cask program failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const rust = emitRust(result.program)
  const prelude = nativePrelude(result.program, 'rust', readRuntime, rust)
  const source = [prelude, rust, `fn main() {\n  ${driver}\n}`, ''].join('\n')
  const project = path.join(work, 'cargo')
  mkdirSync(path.join(project, 'src'), { recursive: true })
  writeFileSync(path.join(project, 'src/main.rs'), source)
  writeFileSync(path.join(project, 'Cargo.toml'), cargoManifest(crate, source))

  const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' }).status === 0
  const native = [prelude, rust].join('\n')

  if (plan.rustPlatform(target) === process.platform) {
    runTool('cargo', ['build', '--release', '--quiet'], { cwd: project })

    return { project, exe: path.join(project, 'target/release', target === 'windows' ? `${crate}.exe` : crate), native }
  }

  if (cargo) {
    // the emitted program against the runtime's signatures, on this platform's stub half
    runTool('cargo', ['check', '--quiet'], { cwd: project })
  }

  return { project, native }
}

// the app's directory on Linux (`<Name>/bin/<crate>` beside `<Name>/resources`) and Windows (`<Name>/<Name>.exe`
// beside `<Name>/resources`), which is what `bundle-path` walks from the executable to find
export function assembleRustBundle({
  out,
  name,
  target,
}: {
  out: string
  name: string
  target: CaskTarget
}): { app: string; exe: string; resources: string } {
  const app = path.join(out, name)
  const resources = path.join(app, 'resources')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(resources, { recursive: true })

  if (target === 'windows') {
    return { app, exe: path.join(app, `${name}.exe`), resources }
  }

  mkdirSync(path.join(app, 'bin'), { recursive: true })

  return { app, exe: path.join(app, 'bin', crateOf(name)), resources }
}

async function makeRustCask({
  root,
  page,
  entry,
  name,
  out,
  work,
  target,
  url,
  publish,
  channel,
}: {
  root: string
  page: string
  entry: string
  name: string
  out: string
  work: string
  target: CaskTarget
  url?: string
  publish?: string
  channel?: string
}): Promise<{ app: string }> {
  const bundle = assembleRustBundle({ out, name, target })
  const pageDir = path.join(bundle.resources, 'webview')

  const pageStarted = Date.now()
  const built = await buildPage({
    root,
    page,
    entry: `import { boot } from './app'\nboot()\n`,
    into: pageDir,
    title: name,
    work: path.join(work, 'page'),
  })
  reportPage(built.bytes, pageStarted)
  const programStarted = Date.now()

  // the page directory is found at run time from the executable, so the same binary runs wherever the app lands
  const { project, exe, native } = buildRustProgram({
    root,
    entry,
    driver: url
      ? `boot(String::from(${JSON.stringify(url)}), true);`
      : 'boot(format!("{}/webview", cask::bundle_path()), false);',
    work,
    crate: crateOf(name),
    target,
  })
  const stamped = stampRuntimeVersion({ target, native, into: bundle.resources })
  stampUpdateKey({ identifier: appIdentity(root).identifier, into: bundle.resources })
  publishBuilt({ publish, channel, page: path.join(bundle.resources, 'webview'), identifier: appIdentity(root).identifier, platform: target, runtimeVersion: stamped.hex })

  if (exe) {
    copyFileSync(exe, bundle.exe)

    if (target === 'windows') {
      // the WebView2 loader is a DLL the executable links dynamically; cargo leaves it in the build directory and
      // Windows refuses to start the app without it beside the executable, silently
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
      const build = path.join(project, 'target/release/build')
      const loader = existsSync(build)
        ? readdirSync(build)
            .filter(name => name.startsWith('webview2-com-sys-'))
            .map(name => path.join(build, name, 'out', arch, 'WebView2Loader.dll'))
            .find(file => existsSync(file))
        : undefined

      if (loader) {
        copyFileSync(loader, path.join(bundle.app, 'WebView2Loader.dll'))
      }
    }

    report({ glyph: 'done', verb: 'build', subject: 'program', duration: Date.now() - programStarted, facts: [target] })
  } else {
    // the page and the cargo project are written; the executable is built on the target's own box
    report({
      glyph: 'skipped',
      verb: 'build',
      subject: 'program',
      duration: Date.now() - programStarted,
      facts: [target],
      fields: [field('reason', `This is not a ${target} box, so the executable is built there.`), location(showPath(project, root))],
    })
  }

  finishCask(root, bundle.app, `${name} built for ${target}`)

  return { app: bundle.app }
}

// ---- android ----

// where the Android SDK and the Kotlin standard library are on this machine, or why the build cannot go on
export function androidTools(): {
  sdk: string
  platform: string
  buildTools: string
  stdlib: string
  adb: string
} {
  const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? path.join(process.env.HOME ?? '', 'Library/Android/sdk')
  const platform = path.join(sdk, 'platforms', `android-${ANDROID_PLATFORM}`, 'android.jar')

  if (!existsSync(platform)) {
    throw refusal(`no Android platform ${ANDROID_PLATFORM} at ${platform}. Run task/android/install-android-cli.sh`, 'environment')
  }

  const buildToolsRoot = path.join(sdk, 'build-tools')
  const versions = existsSync(buildToolsRoot)
    ? readdirSync(buildToolsRoot).filter(name => existsSync(path.join(buildToolsRoot, name, 'aapt2'))).sort()
    : []
  // the newest build tools that carry aapt2
  const newest = versions.at(-1)

  if (!newest) {
    throw refusal(`no Android build tools with aapt2 under ${buildToolsRoot}. The SDK install may still be running`, 'environment')
  }

  const kotlinc = execFileSync('which', ['kotlinc'], { encoding: 'utf8' }).trim()
  const stdlib = [
    path.join(path.dirname(realpathSync(kotlinc)), '..', 'lib', 'kotlin-stdlib.jar'),
    path.join(path.dirname(realpathSync(kotlinc)), '..', 'libexec', 'lib', 'kotlin-stdlib.jar'),
  ].find(candidate => existsSync(candidate))

  if (!stdlib) {
    throw refusal('kotlin-stdlib.jar was not found beside kotlinc', 'environment')
  }

  return {
    sdk,
    platform,
    buildTools: path.join(buildToolsRoot, newest),
    stdlib,
    adb: path.join(sdk, 'platform-tools', 'adb'),
  }
}

// the Activity a cask app starts at, its `program()` running `start` (the Kotlin of the program's first call), and the two
// names the device runtimes ask of the app's host (site/code/view/native/toolkit/runtime/native-*.kt): `hostActivity()`
// and `hostPermissionAnswers`. They are written HERE because this is what makes the cask the app's host. A program
// drawn in Android's own views or in Compose links the cask runtime for `data-path` alone, and its own host defines
// them, so the cask runtime (cask/code/native/kotlin/runtime/cask.kt) cannot (device-layer-0013)
export function caskAndroidDriver(start: string): string {
  return [
    'class TermActivity : CaskActivity() {',
    `  override fun program() { ${start} }`,
    '}',
    '',
    'fun hostActivity(): android.app.Activity? = cask.activity',
    '',
    'val hostPermissionAnswers = mutableListOf<(Int) -> Unit>()',
  ].join('\n')
}

// the cask program compiled to Kotlin with the cask runtime prepended, an Activity the build writes calling the
// program's `boot`, compiled against android.jar and dexed
export function buildAndroidProgram({
  root,
  entry,
  identifier,
  driver,
  work,
  env = 'android',
}: {
  root: string
  entry: string
  identifier: string
  driver: string
  work: string
  // `android`, whose chain reaches the toolkit hosts: the toolkit view host for a program drawn in Android's own views
  // (native-dom-0006), and for the cask's own program the device modules' hosts (device-layer-0013). Under bare
  // `kotlin` a cask answered every device call with its `unavailable` fallback
  env?: 'kotlin' | 'android'
}): { dex: string; native: string } {
  const tools = androidTools()
  const result = compile(
    { file: entry, text: readFileSync(entry, 'utf8') },
    { resolve: projectResolver(root, env), env },
  )

  if (!result.ok) {
    throw refusal(
      `the cask program failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const kotlin = emitKotlin(result.program)
  const prelude = nativePrelude(result.program, env, readRuntime, kotlin)
  // one package, the app's identifier, so the manifest's `.TermActivity` resolves; imports hoisted above everything
  const source = `package ${identifier}\n\n${hoistKotlinImports([prelude, kotlin, driver].join('\n'))}\n`
  const file = path.join(work, 'app.kt')
  const classes = path.join(work, 'classes')
  const dexDir = path.join(work, 'dex')
  rmSync(classes, { recursive: true, force: true })
  rmSync(dexDir, { recursive: true, force: true })
  mkdirSync(classes, { recursive: true })
  mkdirSync(dexDir, { recursive: true })
  writeFileSync(file, source)

  // Term's types already rule out a null where a non-null is declared, so kotlinc's own null checks at every public
  // function's entry (`Intrinsics.checkNotNullParameter`) and around every call are dead weight: the three flags drop
  // them (note/term/codegen/android.md, Build)
  runTool(
    'kotlinc',
    ['-cp', tools.platform, '-d', classes, '-nowarn', '-Xno-param-assertions', '-Xno-call-assertions', '-Xno-receiver-assertions', file],
  )

  const classFiles: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (name.endsWith('.class')) {
        classFiles.push(full)
      }
    }
  }
  walk(classes)

  runTool(
    path.join(tools.buildTools, 'd8'),
    // `--release`: d8's default is a debug dex, with debug information kept and no optimization of the bytecode
    ['--release', '--lib', tools.platform, '--min-api', String(ANDROID_MINIMUM), '--output', dexDir, ...classFiles, tools.stdlib],
  )

  return { dex: path.join(dexDir, 'classes.dex'), native: [prelude, kotlin].join('\n') }
}

// `--publish`: the page that was just built, as an update for exactly the runtime version that was just stamped, so a
// publish can never pair a page with a native half it was not built against
function publishBuilt({
  publish,
  channel,
  page,
  identifier,
  platform,
  runtimeVersion,
}: {
  publish?: string
  channel?: string
  page: string
  identifier: string
  platform: string
  runtimeVersion: string
}): void {
  if (!publish) {
    return
  }

  const { manifest, file } = publishUpdate({ page, out: path.resolve(publish), identifier, platform, runtimeVersion, channel: channel ?? 'main' })
  report({ glyph: 'added', kind: 'change', verb: 'publish', subject: manifest.id, facts: [channel ?? 'main'], fields: [location(showPath(file))] })
}

// stamp the runtime version into the app: one sha256 over the native half as compiled (the generated dispatcher and
// its allowlist, the runtime shims, the program), the target, its minimum OS and the toolchain. A page update is
// compatible exactly when its runtime version equals this file's. See runtime-version.ts and note/term/app/13.
export function stampRuntimeVersion({
  target,
  native,
  into,
}: {
  target: CaskTarget
  native: string
  into: string
}): RuntimeVersion {
  const version = runtimeVersion({
    target,
    minimum: plan.minimumOf(target),
    toolchain: toolchainOf(target),
    sources: [{ name: 'program', text: native }],
  })
  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'runtime-version'), `${version.hex}\n`)
  // the tone code is an identifier of 64 characters, a field value that wraps on its own line rather than a fact that
  // leaves the clock alone on the facts line
  report({ glyph: 'info', verb: 'stamp', subject: 'runtime version', fields: [field('version', version.tone)] })

  return version
}

// the APK: a manifest linked by aapt2 with the page and the app's files as assets, the dex added, aligned, and signed
// with a debug key made on first use
export function assembleApk({
  out,
  name,
  identifier,
  version,
  dex,
  assets,
  work,
  native = '',
}: {
  out: string
  name: string
  identifier: string
  version: string
  dex: string
  assets: string
  work: string
  // the program's native half (buildAndroidProgram's `native`), whose device capabilities decide the permissions the
  // manifest declares (device-declare.ts)
  native?: string
}): string {
  const tools = androidTools()
  const manifest = path.join(work, 'AndroidManifest.xml')
  writeFileSync(manifest, plan.androidManifest(name, identifier, version, permissionLines(native)))

  const unsigned = path.join(work, `${name}-unsigned.apk`)
  const aligned = path.join(work, `${name}-aligned.apk`)
  const apk = path.join(out, `${name}.apk`)
  mkdirSync(out, { recursive: true })
  rmSync(unsigned, { force: true })
  rmSync(aligned, { force: true })
  rmSync(apk, { force: true })

  runTool(path.join(tools.buildTools, 'aapt2'), ['link', '-o', unsigned, '-I', tools.platform, '--manifest', manifest, '-A', assets])
  // classes.dex at the top of the archive. `zip` stores the path as given, so it is added from its own directory
  runTool('zip', ['-q', '-j', unsigned, dex])
  runTool(path.join(tools.buildTools, 'zipalign'), ['-f', '-p', '4', unsigned, aligned])

  const keystore = path.join(process.env.HOME ?? '', '.android', 'debug.keystore')

  if (!existsSync(keystore)) {
    mkdirSync(path.dirname(keystore), { recursive: true })
    execFileSync(
      'keytool',
      ['-genkeypair', '-v', '-keystore', keystore, '-storepass', 'android', '-alias', 'androiddebugkey', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'],
      { stdio: 'ignore' },
    )
  }

  runTool(
    path.join(tools.buildTools, 'apksigner'),
    ['sign', '--ks', keystore, '--ks-pass', 'pass:android', '--ks-key-alias', 'androiddebugkey', '--key-pass', 'pass:android', '--out', apk, aligned],
  )

  return apk
}

// an Android device or emulator adb can see, or the reason there is none
export function androidDevice(): { serial: string } | { missing: string } {
  const tools = androidTools()
  const serial = plan.readySerial(execFileSync(tools.adb, ['devices'], { encoding: 'utf8' }))

  if (!serial) {
    return { missing: 'no Android device is online. Start the emulator: `emulator -avd pixel_api_36`, then `adb devices`' }
  }

  return { serial }
}

// install the APK and launch its Activity. Returns at once; the app's lines are in `adb logcat -s cask`. `extras` are
// the launch Intent's text extras, how a host hands an Activity what a desktop app gets as environment variables
export function launchOnAndroid({ serial, apk, identifier, extras = {} }: { serial: string; apk: string; identifier: string; extras?: Record<string, string> }): void {
  const tools = androidTools()
  runTool(tools.adb, ['-s', serial, 'install', '-r', apk])
  const given = Object.entries(extras).flatMap(([key, value]) => ['--es', key, value])
  runTool(tools.adb, ['-s', serial, 'shell', 'am', 'start', '-n', `${identifier}/.TermActivity`, ...given])
}

// ---- the bundle ----

// the flat `.app` iOS expects: Info.plist, the executable and the resources all at the top. Installed on a simulator
// with `xcrun simctl install`; a device build needs a provisioning profile and a signature, which is the next item
export function assembleIosBundle({
  out,
  name,
  identifier,
  version,
  native = '',
}: {
  out: string
  name: string
  identifier: string
  version: string
  // the program's native half, whose device capabilities decide the usage strings Info.plist carries
  // (device-declare.ts): iOS ends an app that asks for a privacy grant without one
  native?: string
}): { app: string; exe: string; resources: string } {
  const app = path.join(out, `${name}.app`)
  rmSync(app, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })
  writeFileSync(path.join(app, 'Info.plist'), plan.iosPlist(name, identifier, version, usageOf(native)))

  return { app, exe: path.join(app, name), resources: app }
}

// The usage strings a program's device capabilities need (device-declare.ts), added to an Info.plist already written:
// a cask's bundle is made before its program is compiled, so its capabilities are known only after. A key the plist
// already carries is left as it is
export function declareUsage(input: { plist: string; native: string }): void {
  if (!existsSync(input.plist)) {
    return
  }

  const update = plan.usageAdded(readFileSync(input.plist, 'utf8'), usageOf(input.native))

  if (update.missing > 0) {
    writeFileSync(input.plist, update.text)
  }
}

// the usage strings a program's native half needs, in the order device-declare.ts gives them
function usageOf(native: string): plan.UsageText[] {
  return Object.entries(appleUsage(native)).map(([key, said]) => ({ key, said }))
}

// a booted iOS simulator to run a cask on, or the reason there is none. Boots the first available iPhone when none
// is booted; creating a device needs a runtime, and installing one is `xcodebuild -downloadPlatform iOS`
export function simulator(): { udid: string } | { missing: string } {
  const list = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' })
  const devices = Object.values(JSON.parse(list).devices as Record<string, { udid: string; name: string; state: string }[]>).flat()
  const booted = devices[plan.phoneOf(devices.map(device => device.name), devices.map(device => device.state))]

  if (!booted) {
    return { missing: 'no iOS simulator runtime is installed. Run `xcodebuild -downloadPlatform iOS`, then `term make --target ios` again' }
  }

  if (booted.state !== 'Booted') {
    runTool('xcrun', ['simctl', 'boot', booted.udid])
  }

  return { udid: booted.udid }
}

// install the app on a simulator and launch it. Returns at once; the app keeps running on the simulator. The smoke
// test attaches the console itself (`simctl launch --console`), which returns only when the app exits, and an app
// that never exits would hold `term make` forever
export function launchOnSimulator({ udid, app, identifier }: { udid: string; app: string; identifier: string }): void {
  // a clean install: the simulator keeps an earlier install's Info.plist decisions (the launch screen, the display
  // mode) across an install over it, so a rebuilt app kept running letterboxed until it was removed first
  spawnSync('xcrun', ['simctl', 'terminate', udid, identifier], { stdio: 'ignore' })
  spawnSync('xcrun', ['simctl', 'uninstall', udid, identifier], { stdio: 'ignore' })
  runTool('xcrun', ['simctl', 'install', udid, app])
  runTool('xcrun', ['simctl', 'launch', udid, identifier])
}

// the `.app` layout AppKit expects, so the process gets a Dock icon and a menu bar of its own
export function assembleBundle({
  out,
  name,
  identifier,
  version,
}: {
  out: string
  name: string
  identifier: string
  version: string
}): { app: string; exe: string; resources: string } {
  const app = path.join(out, `${name}.app`)
  const contents = path.join(app, 'Contents')
  const macos = path.join(contents, 'MacOS')
  const resources = path.join(contents, 'Resources')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(path.join(contents, 'Info.plist'), plan.macosPlist(name, identifier, version))

  return { app, exe: path.join(macos, name), resources }
}

// sign the bundle: ad hoc (`-`) so Gatekeeper on this machine runs it, or with a Developer ID identity when given.
// Notarization is the identity's owner's step after this, with `notarytool`, and is not run here
export function signBundle({ app, identity }: { app: string; identity?: string }): void {
  runTool('codesign', ['--force', '--deep', '--sign', identity ?? '-', app])
  runTool('codesign', ['--verify', '--deep', '--strict', app])
}

// a `.dmg` holding the app, the way a macOS download ships
export function makeDmg({ app, name, out }: { app: string; name: string; out: string }): string {
  const dmg = path.join(out, `${name}.dmg`)
  rmSync(dmg, { force: true })
  runTool('hdiutil', ['create', '-volname', name, '-srcfolder', app, '-ov', '-format', 'UDZO', '-quiet', dmg])

  return dmg
}

// the env each target's cask program is compiled for, which decides how its `{platform}` loads resolve
const CASK_PROGRAM_ENV: Record<CaskTarget, NativeEnv> = { macos: 'macos', ios: 'ios', android: 'android', windows: 'rust', linux: 'rust' }

// the app's scope (deck/call/code/scope.ts): what its page reaches (and so what crosses the bridge) and what its cask
// program reaches natively, each capability of it named in the app's scope.tree, or the build is refused
function checkCaskScope(input: { root: string; page: string; entry: string; target: CaskTarget }): void {
  const closure = (file: string, env: NativeEnv) =>
    collectModules({ file, text: readFileSync(file, 'utf8') }, projectResolver(input.root, env)).sources.map(one => one.file)

  checkScope({ root: input.root, files: [...closure(input.page, 'webview'), ...closure(input.entry, CASK_PROGRAM_ENV[input.target])] })
}

// ---- the command ----

export async function makeCask(input: {
  root: string
  target: CaskTarget
  // the page entry, a module exporting a `boot` task that mounts the page. Default face/base.tree
  page?: string
  // the cask entry, a module exporting `boot(bundle)`. Default cask.tree
  entry?: string
  // the dev loop: load this URL instead of the bundled page
  url?: string
  // a Developer ID identity for codesign; ad hoc when absent
  sign?: string
  // also make a .dmg
  dmg?: boolean
  version?: string
  // also publish the page just built as an over-the-air update for the runtime version just stamped, into this
  // directory (update.ts documents the layout), on `channel` (default `main`)
  publish?: string
  channel?: string
}): Promise<{ app: string }> {
  // a run of its own, unless one is open: `term work --target` holds the run and builds the cask inside it
  owned = !isRunOpen()

  if (owned) {
    openRun({ verb: 'make', root: input.root, facts: [`--target ${input.target}`] })
  }

  if (!CASK_TARGETS.includes(input.target)) {
    throw refusal(`target ${input.target} is not built yet. Today: ${CASK_TARGETS.join(', ')}`, 'usage')
  }

  if ((input.target === 'macos' || input.target === 'ios') && process.platform !== 'darwin') {
    throw refusal('an Apple cask builds on macOS, where swiftc, codesign and the simulator are', 'environment')
  }

  // the toolchain, before anything is built: a missing `cargo` or `swiftc` was found where the build first called
  // it, after the bridge and the program had been made (guides: basics/install, 2026-10-04). `term show tools` lists
  // them all
  const missing = plan.caskTools(input.target, process.platform).filter(tool => toolVersion(tool) === undefined)

  if (missing.length > 0) {
    throw refusal(plan.missingToolsMessage(input.target, missing), 'environment')
  }

  const root = path.resolve(input.root)
  const page = path.resolve(root, input.page ?? DEFAULT_PAGE)
  const entry = path.resolve(root, input.entry ?? DEFAULT_ENTRY)

  for (const [what, file] of [['page', page], ['cask entry', entry]] as const) {
    if (!existsSync(file)) {
      throw refusal(`no ${what} at ${file}`, 'usage')
    }
  }

  const { name, identifier } = appIdentity(root)
  const out = path.join(root, 'host', input.target)
  const work = path.join(out, 'work')
  const version = input.version ?? '0.0.2'

  // 0. the app's scope (app-scope): every capability its page or its cask program reaches is one its scope.tree names
  checkCaskScope({ root, page, entry, target: input.target })

  // 1. the bridge, from the page's docks, its gate from the app's scope
  reportBridge(generateBridge({ page, out: path.dirname(entry), commit: true, root }))

  if (input.target === 'android') {
    return makeAndroidCask({ root, page, entry, name, identifier, out, work, version, url: input.url, publish: input.publish, channel: input.channel })
  }

  if (input.target === 'linux' || input.target === 'windows') {
    return makeRustCask({ root, page, entry, name, out, work, target: input.target, url: input.url, publish: input.publish, channel: input.channel })
  }

  // 4 first, because the page and the program land inside the bundle
  const bundle =
    input.target === 'ios'
      ? assembleIosBundle({ out, name, identifier, version })
      : assembleBundle({ out, name, identifier, version })
  const pageDir = path.join(bundle.resources, 'webview')

  // 2. the page
  const pageStarted = Date.now()
  const built = await buildPage({
    root,
    page,
    entry: `import { boot } from './app'\nboot()\n`,
    into: pageDir,
    title: name,
    work: path.join(work, 'page'),
  })
  reportPage(built.bytes, pageStarted)

  // 3. the program. `boot` gets the page directory, or the dev URL when asked
  const programStarted = Date.now()
  const program = buildProgram({
    root,
    entry,
    // on iOS the page directory is found at run time from the bundle, since the app is installed elsewhere
    driver:
      input.target === 'ios' && !input.url
        ? `boot(cask.bundlePath() + "/webview", false)`
        : `boot(${JSON.stringify(input.url ?? pageDir)}, ${input.url ? 'true' : 'false'})`,
    exe: bundle.exe,
    work,
    target: input.target,
    identifier,
  })
  report({ glyph: 'done', verb: 'build', subject: 'program', duration: Date.now() - programStarted, facts: [input.target] })
  // the usage strings its device capabilities need, now that the program is known, before the bundle is signed
  declareUsage({ plist: input.target === 'ios' ? path.join(bundle.app, 'Info.plist') : path.join(bundle.app, 'Contents', 'Info.plist'), native: program.native })
  const stamped = stampRuntimeVersion({ target: input.target, native: program.native, into: bundle.resources })
  stampUpdateKey({ identifier, into: bundle.resources })
  publishBuilt({ publish: input.publish, channel: input.channel, page: pageDir, identifier, platform: input.target, runtimeVersion: stamped.hex })

  if (input.target === 'ios') {
    // a simulator build runs unsigned. A device build is signed with the identity and profile the next item brings
    launchOn(simulator(), found => launchOnSimulator({ udid: found.udid, app: bundle.app, identifier }), 'simulator')
    finishCask(root, bundle.app, `${name} built for the iOS simulator, unsigned`)

    return { app: bundle.app }
  }

  signBundle({ app: bundle.app, identity: input.sign })
  report({ glyph: 'done', verb: 'sign', subject: name, facts: [input.sign ?? 'ad hoc'] })

  if (input.dmg) {
    const dmg = makeDmg({ app: bundle.app, name, out })
    report({ glyph: 'done', verb: 'build', subject: 'disk image', fields: [location(showPath(dmg, root))] })
  }

  finishCask(root, bundle.app, `${name} built for ${input.target}`)

  return { app: bundle.app }
}

// ---- what the cask build prints (section 9: one step item each, through code/output.ts) ----

// whether makeCask opened the run it prints into, so it closes only its own
let owned = false

// an error a person can act on, not a bug in Term: `expected` keeps failRun from reporting it as a crash (exit 70),
// and `failure` is the exit it means (section 18): `environment` for a toolchain this machine lacks, `usage` for a
// target or an entry that is not there
function refusal(message: string, failure = ''): Error {
  return Object.assign(new Error(message), { expected: true, failure })
}

function reportBridge(generated: { carried: number; refused: unknown[]; written: number }): void {
  report({
    glyph: generated.refused.length > 0 ? 'warning' : 'done',
    verb: 'build',
    subject: 'bridge',
    counts: [
      count(generated.carried, 'commands', 'command'),
      ...(generated.refused.length > 0 ? [count(generated.refused.length, 'refused')] : []),
      count(generated.written, 'written'),
    ],
  })
}

function reportPage(bytes: number, started: number): void {
  report({ glyph: 'done', verb: 'build', subject: 'page', duration: Date.now() - started, bytes })
}

// a launch on a device or simulator when one is there, or a skipped `launch` item saying why not
function launchOn<T extends object>(found: T | { missing: string }, launch: (found: T) => void, where: string): void {
  if ('missing' in found) {
    report({ glyph: 'skipped', verb: 'launch', subject: where, fields: [field('reason', found.missing)] })

    return
  }

  const started = Date.now()
  launch(found)
  report({ glyph: 'done', verb: 'launch', subject: where, duration: Date.now() - started })
}

// the app's place as the build's last item, and the run closed when makeCask opened it
function finishCask(root: string, app: string, verdict: string): void {
  report({ glyph: 'done', verb: 'write', subject: 'app', fields: [location(showPath(app, root))] })

  if (owned) {
    owned = false
    closeRun({ verdict })
  }
}

// the Android build: the page and the app's files as assets, the program as a dex, one signed APK, installed and
// launched when a device is online
async function makeAndroidCask({
  root,
  page,
  entry,
  name,
  identifier,
  out,
  work,
  version,
  url,
  publish,
  channel,
}: {
  root: string
  page: string
  entry: string
  name: string
  identifier: string
  out: string
  work: string
  version: string
  url?: string
  publish?: string
  channel?: string
}): Promise<{ app: string }> {
  reportBridge(generateBridge({ page, out: path.dirname(entry), commit: true, root }))

  const assets = path.join(work, 'assets')
  rmSync(assets, { recursive: true, force: true })
  mkdirSync(assets, { recursive: true })
  const pageStarted = Date.now()
  const built = await buildPage({ root, page, entry: `import { boot } from './app'\nboot()\n`, into: path.join(assets, 'webview'), title: name, work: path.join(work, 'page') })
  reportPage(built.bytes, pageStarted)

  const programStarted = Date.now()
  const { dex, native } = buildAndroidProgram({
    root,
    entry,
    identifier,
    // the Activity the system starts: it runs the program's `boot`, which opens the window the Activity then shows
    driver: caskAndroidDriver(`boot(${JSON.stringify(url ?? 'webview')}, ${url ? 'true' : 'false'})`),
    work,
  })

  report({ glyph: 'done', verb: 'build', subject: 'program', duration: Date.now() - programStarted, facts: ['android'] })

  // into the assets before they are packaged, so the app reads it from its own APK
  const stamped = stampRuntimeVersion({ target: 'android', native, into: assets })
  stampUpdateKey({ identifier, into: assets })
  publishBuilt({ publish, channel, page: path.join(assets, 'webview'), identifier, platform: 'android', runtimeVersion: stamped.hex })
  const apk = assembleApk({ out, name, identifier, version, dex, assets, work, native })
  launchOn(androidDevice(), found => launchOnAndroid({ serial: found.serial, apk, identifier }), 'device')
  finishCask(root, apk, `${name} built for android, debug signed`)

  return { app: apk }
}

// `term work --target <platform>`: the page served by the dev server with hot swaps, the cask built once with
// `load-url` at it and launched, so a view edit lands inside the WebView with its signals kept. Returns when the app
// is closed; the server lives as long as this process
export async function workCask(input: { root: string; target: CaskTarget; page?: string; entry?: string; port?: number }): Promise<void> {
  const root = path.resolve(input.root)
  const page = path.resolve(root, input.page ?? DEFAULT_PAGE)
  const port = input.port ?? 5179
  const { startDevServer } = await import('@term/call/code/dev/server')
  const started = Date.now()
  const server = startDevServer({ root, entry: page, port, env: 'webview', boot: true })
  const url = `http://localhost:${server.port}/`
  // a service (section 11): the dev server's `start` item, the cask built inside this run, `Stopped` at the end
  openRun({ verb: 'work', root, facts: [`--target ${input.target}`] })
  report({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: url, duration: Date.now() - started, fields: [field('page', showPath(page, root))] })

  const watch = (await import('node:fs')).watch(root, { recursive: true }, (_event, name) => {
    const file = typeof name === 'string' ? name : ''
    if (file.endsWith('.tree') && !file.includes('/host/')) {
      server.update(path.join(root, file))
    }
  })

  try {
    const { app } = await makeCask({ root, target: input.target, page: input.page, entry: input.entry, url })

    if (input.target === 'macos') {
      const { name } = appIdentity(root)
      report({
        glyph: 'info',
        kind: 'lifecycle',
        verb: 'start',
        subject: name,
        message: ['Edit a .tree file and the page swaps in place. Close the window to stop.'],
      })
      // spawned, not run synchronously: the dev server lives in this process and a blocking wait would starve it.
      // The app's lines are ADAPTED (section 15), each an item tagged with the app's name, or passed through under
      // --raw
      const { spawn } = await import('node:child_process')
      await new Promise<void>(done => {
        const child = spawn(path.join(app, 'Contents/MacOS', name), [], { stdio: ['ignore', 'pipe', 'pipe'] })
        followChild(child, name)
        child.on('close', () => done())
      })
      closeRun({ verdict: 'Stopped', uptime: true })
    } else {
      report({ glyph: 'info', kind: 'lifecycle', verb: 'start', subject: 'device', message: ['The app is loading the dev server. Ctrl-C stops the server.'] })
      process.once('SIGINT', () => process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true })))
      await new Promise(() => {})
    }
  } finally {
    watch.close()
    server.close()
  }
}
