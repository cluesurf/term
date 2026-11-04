// How a Term app becomes a macOS cask, in three steps the two drivers share: the page compiled to a browser bundle in
// the `webview` env, the program compiled to Swift with the cask runtime prepended, and the `.app` layout AppKit
// expects. `cask-mac.ts` launches the result, `app-smoke.ts` reads its exit status. Design: note/project/term/cask/readme.md.
//
// Runs from the Term root, the way every other term task does, and writes only under tmp/cask/.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { build, type Plugin } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import { nativeFlags } from '../../../test/compile/native-flags'
import { TERM_ROOT } from '../root'

export const TERM = TERM_ROOT
export const CASK = join(TERM, 'deck/cask')
export const OUT = join(TERM, 'tmp/cask')

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

export function say(text: string): void {
  console.log(`cask  ${text}`)
}

export function fail(text: string): never {
  console.error(`cask  ${text}`)
  // the summary line `pnpm term:test` reads, so a failed build counts as a failed check rather than as no output
  console.log('cask: 0 pass, 1 fail')
  process.exit(1)
}

// The browser DOM runtime's anchor shim imports @floating-ui/dom, and a page that never anchors a panel still carries
// that import because the prelude keeps a shim whose name appears anywhere in the emitted code. When the package is
// not installed beside the page, the bundle gets a stub whose members raise on first use, so the app loads and a
// page that does anchor fails at the call rather than at module load. A page that has the package installed
// resolves it as usual: the stub only steps in when esbuild's own resolution finds nothing.
const stubMissingPackages: Plugin = {
  name: 'stub-missing-packages',
  setup(api) {
    api.onResolve({ filter: /^@floating-ui\/dom$/ }, async args => {
      // the re-resolve below comes back through this hook; let it fall through to esbuild's own resolution
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

// 1. the page: compiled in the `webview` env so every native goes over the bridge, bundled by esbuild, started by
// `entry`, which is the line of TypeScript that mounts or boots what the page exports
export async function buildPage({
  page,
  entry,
  into,
  title,
}: {
  page: string
  entry: string
  into: string
  title: string
}): Promise<void> {
  const result = compile(
    { file: page, text: readFileSync(page, 'utf8') },
    { resolve: projectResolver(TERM, 'webview'), env: 'webview' },
  )

  if (!result.ok) {
    fail(
      `page failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const prelude = nativePrelude(
    result.program,
    'webview',
    readRuntime,
    result.typescript,
  )
  const work = join(OUT, 'page')
  rmSync(work, { recursive: true, force: true })
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'app.ts'), `${prelude}\n${result.typescript}`)
  writeFileSync(join(work, 'entry.ts'), entry)

  const bundled = await build({
    entryPoints: [join(work, 'entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    plugins: [stubMissingPackages],
  })

  mkdirSync(into, { recursive: true })
  writeFileSync(join(into, 'app.js'), bundled.outputFiles[0].text)
  writeFileSync(
    join(into, 'index.html'),
    [
      '<!doctype html>',
      `<html><head><meta charset="utf-8"><title>${title}</title>`,
      '<style>body{font:16px system-ui;margin:24px}input,textarea,button{font:inherit;display:block;margin:8px 0}</style>',
      '</head><body><script type="module" src="./app.js"></script></body></html>',
    ].join('\n'),
  )
  say(`page bundled: ${bundled.outputFiles[0].text.length} bytes`)
}

// 2. the app: the Term program compiled to Swift, the cask runtime prepended, and `driver`, the top-level Swift
// line that calls the program's `boot`
export function buildApp({
  app,
  driver,
  exe,
}: {
  app: string
  driver: string
  exe: string
}): void {
  const result = compile(
    { file: app, text: readFileSync(app, 'utf8') },
    { resolve: projectResolver(CASK, 'swift'), env: 'swift' },
  )

  if (!result.ok) {
    fail(
      `app failed to compile: ${result.diagnostics
        .slice(0, 3)
        .map(d => d.message)
        .join('; ')}`,
    )
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, 'swift', readRuntime, swift)
  const source = ['import Foundation', prelude, swift, driver, ''].join('\n')

  const file = join(OUT, 'app.swift')
  writeFileSync(file, source)
  say(`swift emitted: ${source.length} bytes at ${file}`)

  execFileSync('swiftc', [...nativeFlags('swift'), '-O', '-o', exe, file], {
    stdio: 'inherit',
  })
  say(`built ${exe}`)
}

// 3. the bundle: the layout AppKit expects, so the process gets a Dock icon and a menu bar of its own
export function assembleBundle({
  name,
  identifier,
}: {
  name: string
  identifier: string
}): { app: string; exe: string; resources: string } {
  const app = join(OUT, `${name}.app`)
  const contents = join(app, 'Contents')
  const macos = join(contents, 'MacOS')
  const resources = join(contents, 'Resources')
  rmSync(app, { recursive: true, force: true })
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0"><dict>',
      `<key>CFBundleName</key><string>${name}</string>`,
      `<key>CFBundleExecutable</key><string>${name}</string>`,
      `<key>CFBundleIdentifier</key><string>${identifier}</string>`,
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '<key>CFBundleShortVersionString</key><string>0.0.2</string>',
      '<key>LSMinimumSystemVersion</key><string>14.0</string>',
      '<key>NSHighResolutionCapable</key><true/>',
      '</dict></plist>',
      '',
    ].join('\n'),
  )

  return { app, exe: join(macos, name), resources }
}
