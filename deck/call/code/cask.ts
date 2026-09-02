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
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { manifestNameOf } from '@term/call/code/manifest-name'
import { projectResolver } from '@term/call/code/make'
import { generateBridge } from '@term/call/code/cask-generate'
import { logGood, logStep, fade } from '@term/make/code/tint'

export type CaskTarget = 'macos' | 'ios'

export const CASK_TARGETS: CaskTarget[] = ['macos', 'ios']

// the lowest iOS the cask runs on, and the simulator slice it is built for
const IOS_MINIMUM = '17.0'
const IOS_SIMULATOR_TARGET = `arm64-apple-ios${IOS_MINIMUM}-simulator`

// where a page entry and a cask entry live in an app, when the command is not told otherwise
const DEFAULT_PAGE = 'face/base.tree'
const DEFAULT_ENTRY = 'cask.tree'

// the identifier prefix an app gets when its manifest does not say. `surf.term.blog` for `@term/blog`
const IDENTIFIER_PREFIX = 'surf.term'

// the lowest macOS the cask runs on: WKWebView's `takeSnapshot` and the concurrency the runtime uses
const MACOS_MINIMUM = '14.0'

const readRuntime = (file: string): string | undefined =>
  existsSync(file) ? readFileSync(file, 'utf8') : undefined

// The swift flags the stdlib's standard stack needs (swift-nio, Hummingbird), written by task/term/native/swift.sh
// into the native cache. Read when present; an app whose closure never reaches the asynchronous file or server
// modules builds without them. The path is the script's own convention, so the two cannot disagree.
function swiftFlags(): string[] {
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
  const last = (declared ?? path.basename(root)).split('/').pop() ?? 'app'
  const word = last.replace(/[^a-z0-9]/gi, '')

  return {
    name: word.charAt(0).toUpperCase() + word.slice(1),
    identifier: `${IDENTIFIER_PREFIX}.${word.toLowerCase()}`,
  }
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
    throw new Error(
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

  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'app.js'), bundled.outputFiles[0].text)
  writeFileSync(
    path.join(into, 'index.html'),
    [
      '<!doctype html>',
      `<html><head><meta charset="utf-8"><title>${title}</title>`,
      '<style>body{font:16px system-ui;margin:24px}input,textarea,button{font:inherit;display:block;margin:8px 0}</style>',
      '</head><body><script type="module" src="./app.js"></script></body></html>',
    ].join('\n'),
  )

  return { bytes: bundled.outputFiles[0].text.length }
}

// ---- the program ----

// the cask program compiled to Swift, the cask runtime prepended, and `driver`, the top-level Swift line that
// calls the program's `boot`
export function buildProgram({
  root,
  entry,
  driver,
  exe,
  work,
  target = 'macos',
}: {
  root: string
  entry: string
  driver: string
  exe: string
  work: string
  target?: CaskTarget
}): { source: string } {
  const result = compile(
    { file: entry, text: readFileSync(entry, 'utf8') },
    { resolve: projectResolver(root, 'swift'), env: 'swift' },
  )

  if (!result.ok) {
    throw new Error(
      `the cask program failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, 'swift', readRuntime, swift)
  const source = ['import Foundation', prelude, swift, driver, ''].join('\n')
  const file = path.join(work, 'app.swift')
  mkdirSync(work, { recursive: true })
  writeFileSync(file, source)
  mkdirSync(path.dirname(exe), { recursive: true })

  if (target === 'ios') {
    // the iOS simulator SDK through xcrun. The stdlib's macOS package flags (swift-nio, Hummingbird) are not iOS
    // modules and are not passed; an app whose closure reaches them does not build for iOS yet
    const sdk = execFileSync('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()
    execFileSync(
      'xcrun',
      ['-sdk', 'iphonesimulator', 'swiftc', '-target', IOS_SIMULATOR_TARGET, '-sdk', sdk, '-O', '-o', exe, file],
      { stdio: 'inherit' },
    )
  } else {
    execFileSync('swiftc', [...swiftFlags(), '-O', '-o', exe, file], { stdio: 'inherit' })
  }

  return { source: file }
}

// ---- the bundle ----

// the flat `.app` iOS expects: Info.plist, the executable and the resources all at the top. Installed on a simulator
// with `xcrun simctl install`; a device build needs a provisioning profile and a signature, which is the next item
export function assembleIosBundle({
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
  rmSync(app, { recursive: true, force: true })
  mkdirSync(app, { recursive: true })
  writeFileSync(
    path.join(app, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>CFBundleName</key><string>${name}</string>`,
      `<key>CFBundleDisplayName</key><string>${name}</string>`,
      `<key>CFBundleExecutable</key><string>${name}</string>`,
      `<key>CFBundleIdentifier</key><string>${identifier}</string>`,
      '<key>CFBundlePackageType</key><string>APPL</string>',
      `<key>CFBundleShortVersionString</key><string>${version}</string>`,
      `<key>CFBundleVersion</key><string>${version}</string>`,
      `<key>MinimumOSVersion</key><string>${IOS_MINIMUM}</string>`,
      '<key>LSRequiresIPhoneOS</key><true/>',
      '<key>UIDeviceFamily</key><array><integer>1</integer><integer>2</integer></array>',
      '<key>UISupportedInterfaceOrientations</key><array><string>UIInterfaceOrientationPortrait</string></array>',
      '<key>UIRequiresFullScreen</key><true/>',
      '</dict></plist>',
      '',
    ].join('\n'),
  )

  return { app, exe: path.join(app, name), resources: app }
}

// a booted iOS simulator to run a cask on, or the reason there is none. Boots the first available iPhone when none
// is booted; creating a device needs a runtime, and installing one is `xcodebuild -downloadPlatform iOS`
export function simulator(): { udid: string } | { missing: string } {
  const list = execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { encoding: 'utf8' })
  const devices = Object.values(JSON.parse(list).devices as Record<string, { udid: string; name: string; state: string }[]>).flat()
  const phones = devices.filter(device => device.name.startsWith('iPhone'))

  if (phones.length === 0) {
    return { missing: 'no iOS simulator runtime is installed. Run `xcodebuild -downloadPlatform iOS`, then `term make --target ios` again' }
  }

  const booted = phones.find(device => device.state === 'Booted') ?? phones[0]

  if (booted.state !== 'Booted') {
    execFileSync('xcrun', ['simctl', 'boot', booted.udid], { stdio: 'inherit' })
  }

  return { udid: booted.udid }
}

// install the app on a simulator and launch it headless, streaming its console. Returns when the app exits
export function launchOnSimulator({ udid, app, identifier }: { udid: string; app: string; identifier: string }): void {
  execFileSync('xcrun', ['simctl', 'install', udid, app], { stdio: 'inherit' })
  execFileSync('xcrun', ['simctl', 'launch', '--console', udid, identifier], { stdio: 'inherit' })
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
  writeFileSync(
    path.join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>CFBundleName</key><string>${name}</string>`,
      `<key>CFBundleDisplayName</key><string>${name}</string>`,
      `<key>CFBundleExecutable</key><string>${name}</string>`,
      `<key>CFBundleIdentifier</key><string>${identifier}</string>`,
      '<key>CFBundlePackageType</key><string>APPL</string>',
      `<key>CFBundleShortVersionString</key><string>${version}</string>`,
      `<key>CFBundleVersion</key><string>${version}</string>`,
      `<key>LSMinimumSystemVersion</key><string>${MACOS_MINIMUM}</string>`,
      '<key>NSHighResolutionCapable</key><true/>',
      '</dict></plist>',
      '',
    ].join('\n'),
  )

  return { app, exe: path.join(macos, name), resources }
}

// sign the bundle: ad hoc (`-`) so Gatekeeper on this machine runs it, or with a Developer ID identity when given.
// Notarization is the identity's owner's step after this, with `notarytool`, and is not run here
export function signBundle({ app, identity }: { app: string; identity?: string }): void {
  execFileSync('codesign', ['--force', '--deep', '--sign', identity ?? '-', app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
}

// a `.dmg` holding the app, the way a macOS download ships
export function makeDmg({ app, name, out }: { app: string; name: string; out: string }): string {
  const dmg = path.join(out, `${name}.dmg`)
  rmSync(dmg, { force: true })
  execFileSync(
    'hdiutil',
    ['create', '-volname', name, '-srcfolder', app, '-ov', '-format', 'UDZO', '-quiet', dmg],
    { stdio: 'inherit' },
  )

  return dmg
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
}): Promise<{ app: string }> {
  if (!CASK_TARGETS.includes(input.target)) {
    throw new Error(`target ${input.target} is not built yet. Today: ${CASK_TARGETS.join(', ')}`)
  }

  if (process.platform !== 'darwin') {
    throw new Error('an Apple cask builds on macOS, where swiftc, codesign and the simulator are')
  }

  const root = path.resolve(input.root)
  const page = path.resolve(root, input.page ?? DEFAULT_PAGE)
  const entry = path.resolve(root, input.entry ?? DEFAULT_ENTRY)

  for (const [what, file] of [['page', page], ['cask entry', entry]] as const) {
    if (!existsSync(file)) {
      throw new Error(`no ${what} at ${file}`)
    }
  }

  const { name, identifier } = appIdentity(root)
  const out = path.join(root, 'host', input.target)
  const work = path.join(out, 'work')
  const version = input.version ?? '0.0.2'

  logStep(`Building ${name} for ${input.target}...`)

  // 1. the bridge, from the page's docks
  const generated = generateBridge({ page, out: path.dirname(entry), commit: true })
  console.log(fade(`  bridge: ${generated.carried} commands, ${generated.refused.length} refused, ${generated.written} files written`))

  // 4 first, because the page and the program land inside the bundle
  const bundle =
    input.target === 'ios'
      ? assembleIosBundle({ out, name, identifier, version })
      : assembleBundle({ out, name, identifier, version })
  const pageDir = path.join(bundle.resources, 'webview')

  // 2. the page
  const built = await buildPage({
    root,
    page,
    entry: `import { boot } from './app'\nboot()\n`,
    into: pageDir,
    title: name,
    work: path.join(work, 'page'),
  })
  console.log(fade(`  page: ${built.bytes} bytes of JavaScript`))

  // 3. the program. `boot` gets the page directory, or the dev URL when asked
  buildProgram({
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
  })

  if (input.target === 'ios') {
    // a simulator build runs unsigned. A device build is signed with the identity and profile the next item brings
    logGood(`${path.relative(root, bundle.app)} (simulator, unsigned)`)

    const found = simulator()

    if ('missing' in found) {
      console.log(fade(`  not launched: ${found.missing}`))
    } else {
      launchOnSimulator({ udid: found.udid, app: bundle.app, identifier })
    }

    return { app: bundle.app }
  }

  signBundle({ app: bundle.app, identity: input.sign })
  console.log(fade(`  signed: ${input.sign ?? 'ad hoc'}`))

  if (input.dmg) {
    const dmg = makeDmg({ app: bundle.app, name, out })
    console.log(fade(`  ${path.relative(root, dmg)}`))
  }

  logGood(`${path.relative(root, bundle.app)}`)

  return { app: bundle.app }
}
