// `term make --target uikit`: a Term app as a native iPhone app, its views UIKit's, no WebView (swiftui-target-0004),
// built for a DEVICE: the program compiled for the toolkit host the simulator suites run (test/compile/shared/
// toolkit-run.ts), put into a generated Xcode project, archived, and, with a team to sign for, exported as an .ipa.
//
// WHY AN XCODE PROJECT. An iPhone runs only a signed app, signed with a certificate AND a provisioning profile that
// names the app and the phones it may run on. Only Xcode makes and fetches a profile on its own
// (`-allowProvisioningUpdates`), from the account signed in at Xcode → Settings → Accounts. A project around the one
// Swift file is the smallest way to ask it to.
//
//   term make --target uikit                    the project and an unsigned device build: the code builds for a phone
//   term make --target uikit --team <id>        signed ad hoc for the phones registered to that team, as an .ipa
//   term make --target uikit --team <id> --link <https url>
//                                               the same, with the install page an iPhone opens at that address
//
// AD HOC, not development: a development build needs Developer Mode on the phone, and Developer Mode cannot be turned
// on without connecting the phone to a Mac once. An ad hoc build installs from a link (itms-services), on any phone the
// team has registered. The team is read from the signing identity when exactly one is in the keychain.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { collectModules } from '@term/make/code/compile/load'
import { nativePrelude } from '@term/make/code/compile/native'
import { checkScope } from '@term/call/code/scope'
import { appleUsage } from '@term/call/code/device-declare'
import { SWIFT_MODULE } from '@term/call/code/cask'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import { closeRun, location, openRun, report, showPath } from '@term/call/code/output'
// what the build decides beside the compiler and Xcode: the app's names, its start line, the project, the team, the
// install manifest and which of xcodebuild's lines to keep
import * as words from '@term/call/code/uikit-words'

// an app folder's name as the app is named after it, and its bundle identifier
export function uikitIdentity(root: string): { name: string; identifier: string } {
  const identity = words.uikitIdentityOf(basename(root))

  return { name: identity.name, identifier: identity.identifier }
}

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

// the program with the toolkit host's prelude, as one Swift file. In an app target top-level code is allowed only in
// `main.swift`, which is what the file is called
function programSource(input: { root: string; entry: string }): string {
  const text = readFileSync(input.entry, 'utf8')
  const resolve = projectResolver(input.root, 'ios')

  // the app's scope first (app-scope): every capability its modules reach is one its scope.tree names, as a Compose
  // or a cask build refuses it
  try {
    checkScope({ root: input.root, files: collectModules({ file: input.entry, text }, resolve).sources.map(one => one.file) })
  } catch (error) {
    throw refusal(`scope: ${(error as Error).message}`, 'usage')
  }

  const result = compile({ file: input.entry, text }, { resolve, env: 'ios' })

  if (!result.ok) {
    throw refusal(`the app failed to compile: ${result.diagnostics.slice(0, 3).map(d => d.message).join('; ')}`, '')
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, 'ios', readRuntime, swift)
  // `main` throws when anything it reaches can raise, and a raise nothing handles ends the program
  const start = words.startLine(swift)

  return ['import Foundation', prelude, swift, start, ''].join('\n')
}

// A stable 24-digit object id per name, so the same app writes the same project byte for byte
const id = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase()

// The smallest project.pbxproj for one app target with one Swift file and a generated Info.plist. Its build settings
// are the simulator build's flags (cask.ts `buildProgram`): -O, whole module, exclusivity checks off, Swift 5 mode
export function xcodeProject(input: { name: string; identifier: string; version: string; team?: string; usage?: Record<string, string> }): string {
  const { name } = input
  const ids = {
    file: id(`${name}:file`),
    build: id(`${name}:build`),
    product: id(`${name}:product`),
    main: id(`${name}:group`),
    sources: id(`${name}:sources-group`),
    products: id(`${name}:products-group`),
    phase: id(`${name}:phase`),
    target: id(`${name}:target`),
    targetList: id(`${name}:target-list`),
    targetDebug: id(`${name}:target-debug`),
    targetRelease: id(`${name}:target-release`),
    project: id(`${name}:project`),
    projectList: id(`${name}:project-list`),
    projectDebug: id(`${name}:project-debug`),
    projectRelease: id(`${name}:project-release`),
  }
  // in the order the project text takes them (uikit-words.tree `xcode-project`)
  const ordered = [ids.file, ids.build, ids.product, ids.main, ids.sources, ids.products, ids.phase, ids.target, ids.targetList, ids.targetDebug, ids.targetRelease, ids.project, ids.projectList, ids.projectDebug, ids.projectRelease]
  const usage = Object.entries(input.usage ?? {}).map(([key, said]) => ({ key, said }))

  // never the app's own name as its module, which may be an Apple framework's (cask.ts SWIFT_MODULE)
  return words.xcodeProject(name, input.identifier, input.version, input.team ?? '', usage, SWIFT_MODULE, ordered)
}

// The team of the one Apple signing identity in the keychain, when there is exactly one team among them
export function signingTeam(): string | undefined {
  const listed = spawnSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' }).stdout ?? ''

  return words.signingTeam(listed) || undefined
}

// The install page an iPhone opens: an itms-services link to the manifest, which names the .ipa. Both must be served
// over HTTPS with a certificate the phone trusts, from `base`
function installPage(input: { name: string; identifier: string; version: string; base: string; out: string }): string {
  writeFileSync(join(input.out, 'manifest.plist'), words.installManifest(input.name, input.identifier, input.version, input.base))
  const page = join(input.out, 'index.html')
  writeFileSync(page, words.installPage(input.name, input.version, encodeURIComponent(`${input.base}/manifest.plist`)))

  return page
}

function run(command: string, args: string[], cwd: string): void {
  const ran = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })

  if (ran.status !== 0) {
    // xcodebuild's own error lines, which name the setting or the profile at fault
    const said = `${ran.stdout}${ran.stderr}`.split('\n').filter(line => words.isFailureLine(line))
    throw refusal(`${command} ${args[0]} failed: ${(said.length ? said : `${ran.stdout}${ran.stderr}`.split('\n').slice(-20)).join('\n').slice(0, 2400)}`, '')
  }
}

export async function makeUikit(input: { root: string; entry?: string; team?: string; link?: string; version?: string }): Promise<{ app: string }> {
  const entry = join(input.root, input.entry ?? 'app.tree')
  openRun({ verb: 'make', root: input.root, facts: ['--target uikit'] })

  if (process.platform !== 'darwin') {
    throw refusal('an iPhone app builds on macOS, where Xcode is', 'environment')
  }

  if (spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }).status !== 0) {
    throw refusal('an iPhone app needs Xcode, and xcodebuild is not working here', 'environment')
  }

  if (!existsSync(entry)) {
    throw refusal(`There is no app entry at ${showPath(entry, input.root)}: a UIKit app is a program with a \`main\` task (--entry names another file)`, 'usage')
  }

  const { name, identifier } = uikitIdentity(input.root)
  const version = input.version ?? '0.0.2'
  const team = input.team ?? signingTeam()
  const out = join(input.root, 'host', 'uikit')
  const started = Date.now()

  // the project: main.swift and project.pbxproj, rewritten whole each time
  const projectDir = join(out, `${name}.xcodeproj`)
  rmSync(projectDir, { recursive: true, force: true })
  mkdirSync(join(out, name), { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  const source = programSource({ root: input.root, entry })
  writeFileSync(join(out, name, 'main.swift'), source)
  writeFileSync(join(projectDir, 'project.pbxproj'), xcodeProject({ name, identifier, version, team, usage: appleUsage(source) }))
  report({ glyph: 'done', verb: 'write', subject: 'Xcode project', fields: [location(showPath(projectDir, input.root))] })

  const archive = join(out, `${name}.xcarchive`)
  rmSync(archive, { recursive: true, force: true })
  const common = ['-project', projectDir, '-scheme', name, '-configuration', 'Release', '-destination', 'generic/platform=iOS', '-derivedDataPath', join(out, 'derived')]

  if (!team) {
    // no team to sign for: the device build, unsigned, so the code is known to build for a phone
    run('xcodebuild', ['archive', ...common, '-archivePath', archive, 'CODE_SIGNING_ALLOWED=NO', '-quiet'], out)
    report({ glyph: 'done', verb: 'build', subject: 'uikit', duration: Date.now() - started, facts: ['unsigned'], fields: [location(showPath(archive, input.root))] })
    closeRun({ verdict: 'Built for an iPhone, unsigned', next: 'sign in at Xcode → Settings → Accounts and make an Apple Distribution certificate, then term make --target uikit --team <id>' })

    return { app: archive }
  }

  // signed for the team: Xcode makes or fetches the ad hoc profile for the phones registered to it
  run('xcodebuild', ['archive', ...common, '-archivePath', archive, '-allowProvisioningUpdates', `DEVELOPMENT_TEAM=${team}`, '-quiet'], out)
  const options = join(out, 'export.plist')
  writeFileSync(options, words.exportOptions(team))
  const exported = join(out, 'export')
  rmSync(exported, { recursive: true, force: true })
  run('xcodebuild', ['-exportArchive', '-archivePath', archive, '-exportOptionsPlist', options, '-exportPath', exported, '-allowProvisioningUpdates'], out)
  const ipa = join(exported, `${name}.ipa`)

  if (!existsSync(ipa)) {
    throw refusal(`the export wrote no ${name}.ipa in ${showPath(exported, input.root)}`, '')
  }

  report({ glyph: 'done', verb: 'build', subject: 'uikit', duration: Date.now() - started, facts: [`signed ad hoc for ${team}`], fields: [location(showPath(ipa, input.root))] })

  if (input.link) {
    const page = installPage({ name, identifier, version, base: input.link.replace(/\/$/, ''), out: exported })
    report({ glyph: 'done', verb: 'write', subject: 'install page', fields: [location(showPath(page, input.root))] })
  }

  closeRun({ verdict: 'iPhone app built and signed', next: input.link ? `serve ${showPath(exported, input.root)} at ${input.link}, then open it in Safari on the phone` : 'term make --target uikit --link <https url> also writes the install page' })

  return { app: ipa }
}

// an error a person can act on, not a bug in Term: `expected` keeps failRun from treating it as a crash
function refusal(message: string, failure: string): Error {
  return Object.assign(new Error(message), { expected: true, failure })
}
