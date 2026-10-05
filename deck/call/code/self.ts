// `term self`: the versions of the `term` command on this machine (note/term/plan/term-load-install.md,
// note/term/plan/term-versions.md).
//
//   check    is the copy running this the signed release it claims to be
//   update   install the newest release and move the front to it
//   back     move the front to the version before it, no download
//   list     what is installed, the front, the default, what runs here, and when each was last used
//   find     what is released, newest first
//   load     install a version, switching nothing
//   pick     the default outside any project (need.tree)
//   need     this project's request (deck.tree) and its pin (lock.tree)
//   show     which version runs here, and every rule that decided it
//   toss     remove one version
//   wash     list what nothing has used in --days, and remove it with --commit
//
// `self` RUNS ON THE COPY THAT WAS STARTED, never on a project's version (need-run.ts): managing versions is the
// front's job, and a project pinned to an older release must not take `term self` back to that release's verbs.
//
// THE FRONT AND THE VERSION THAT RUNS ARE TWO THINGS. `bin/term` is the front: the one thing on PATH, which starts and
// dispatches. Which version a command runs is resolution's answer (need.ts), so `update` and `back` move the front and
// change nothing a pinned project runs.
//
// A COPY THIS DID NOT INSTALL is said to be so. Homebrew, apt, dnf and winget update their own (task/distro.ts makes
// the last three), and a source checkout is built, not installed, so `update` and `back` refuse all of them, naming the
// way that does work. Every other verb works from any of them: a packaged `term` is a front like any other.

import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs'
import nodePath from 'path'
import { fileURLToPath } from 'url'

import {
  codeMatch,
  currentPlatform,
  loadLockfile,
  loadManifest,
  parseCode,
  parseCodeHold,
  pinNeed,
  readReleaseIndex,
  saveLockfile,
  showCode,
  transportFor,
  writeManifest,
} from '@cluesurf/deck.tree'
import { compareCode } from '@term/deck/code/code'
import type { CodeHold, Lockfile } from '@term/deck/code/form'

import { userHome } from '@term/call/code/home'
import {
  TOOLCHAIN,
  chooseFor,
  currentWorld,
  defaultRequest,
  installedVersions,
  pinHolds,
  projectRequest,
  readRequest,
  type NeedChoice,
  type NeedRequest,
} from '@term/call/code/need'
import {
  PACKAGE,
  frontVersion,
  installFile,
  isInstalled,
  lastUsed,
  linkFront,
  listReleases,
  loadVersion,
  readInstall,
  routeOf,
  sharedFacts,
  verifyRelease,
  type Install,
  type Loaded,
} from '@term/call/code/need-load'
import { closeRun, count, field, location, openRun, report, showPath } from '@term/call/code/output'

// how long `wash` waits before it calls a version unused
const WASH_DAYS = 90

const DAY_MS = 24 * 60 * 60 * 1000

// a package manager that installed `term` and updates it: Homebrew, apt and dnf (both at /usr/lib/term, told apart by
// dpkg's own record of the package), and winget (its package folder for ClueSurf.Term)
type Manager = 'homebrew' | 'apt' | 'dnf' | 'winget'

type Held = { form: 'installed'; install: Install } | { form: 'managed'; by: Manager; version: string } | { form: 'source'; version: string }

// each manager as its own project writes its name
const SPELLED: Record<Manager, string> = { homebrew: 'Homebrew', apt: 'apt', dnf: 'dnf', winget: 'winget' }

// how each manager updates its copy, said when `term self update` or `back` is refused
const UPDATE: Record<Manager, string> = {
  homebrew: 'brew upgrade cluesurf/tool/term',
  apt: 'sudo apt update, then sudo apt install --only-upgrade term',
  dnf: 'sudo dnf upgrade term',
  winget: 'winget upgrade ClueSurf.Term',
}

// ---- check, update, back ----

export async function callSelfCheck(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'check' })

  const held = whatRuns()
  const platform = held.form === 'installed' ? held.install.platform : currentPlatform()
  const version = held.form === 'installed' ? held.install.version : held.version

  if (!platform) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `No release is built for ${process.platform}-${process.arch}` })
    closeRun({ verdict: 'Not checked', failure: 'environment' })

    return
  }

  const verified = await verifyRelease({ version, platform })

  if (!verified.ok) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: verified.reason })
    closeRun({ verdict: `${PACKAGE}@${version} did not verify`, failure: 'environment' })

    return
  }

  if (held.form !== 'installed') {
    // a release exists for this version and is signed, but these bytes were not installed from it by term.surf/load
    report({
      glyph: 'info',
      verb: 'check',
      subject: `${PACKAGE}@${version} for ${platform} is released and signed by ${verified.keys}`,
      message: [
        held.form === 'managed'
          ? held.by === 'homebrew'
            ? 'Homebrew installed this copy and checked its download against the same layer digest.'
            : `${SPELLED[held.by]} installed this copy from a package of the same payload, checked by its own signature.`
          : 'This copy is a source build, so its bytes are not compared with the release.',
      ],
    })
    closeRun({ verdict: 'The release verifies' })

    return
  }

  if (verified.layer !== held.install.hash) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'check',
      subject: `This install was unpacked from ${held.install.hash}, and the signed release is ${verified.layer}`,
    })
    closeRun({ verdict: 'This install is not the release', failure: 'environment' })

    return
  }

  report({
    glyph: 'done',
    verb: 'check',
    subject: `${PACKAGE}@${version} for ${platform}`,
    fields: [field('layer', verified.layer), field('signed', verified.keys)],
  })
  closeRun({ verdict: 'This install is the signed release' })
}

export async function callSelfUpdate(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'update' })

  const held = whatRuns()

  if (held.form !== 'installed') {
    refuseUnmanaged(held)

    return
  }

  const front = frontVersion() ?? held.install.version
  const newest = (await releases())?.[0]

  if (!newest) {
    closeRun({ verdict: 'Nothing was changed', failure: 'environment' })

    return
  }

  if (compare(newest, front) <= 0) {
    report({ glyph: 'info', verb: 'update', subject: `${PACKAGE}@${front} is the newest release` })
    closeRun({ verdict: 'Already up to date' })

    return
  }

  const loaded = await loadVersion({ version: newest, platform: held.install.platform })

  if (!reportLoaded(loaded)) {
    closeRun({ verdict: `${PACKAGE}@${newest} was not installed`, failure: 'environment' })

    return
  }

  linkFront(newest)
  report({ glyph: 'changed', kind: 'change', verb: 'front', subject: `bin/term ${front} to ${newest}` })

  // a range default follows on its own; an exact one is named, because it now holds the default back
  const fallback = defaultRequest(userHome()).request
  const message =
    fallback && !codeMatch(parseCode(newest), fallback.hold)
      ? [`The default is ${fallback.text} (term self pick), so outside a project term ${fallback.text} still runs, not ${newest}.`]
      : []

  closeRun({ verdict: `Updated to ${newest}`, message, done: true, next: 'term self back, to return to the previous version' })
}

export async function callSelfBack(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'back' })

  const held = whatRuns()

  if (held.form !== 'installed') {
    refuseUnmanaged(held)

    return
  }

  const front = frontVersion() ?? held.install.version
  const previous = installedVersions(userHome()).find(version => compare(version, front) < 0)

  if (!previous) {
    report({ glyph: 'failed', kind: 'problem', verb: 'back', subject: `No version older than ${front} is installed here` })
    closeRun({ verdict: 'Nothing to go back to', failure: 'usage', next: 'term self find, then term self load <version>' })

    return
  }

  linkFront(previous)
  report({ glyph: 'changed', kind: 'change', verb: 'front', subject: `bin/term ${front} to ${previous}` })
  closeRun({ verdict: `Back on ${previous}`, done: true, next: 'term self update, to move forward again' })
}

// ---- list, find ----

export async function callSelfList(input: { root: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'list' })

  const home = userHome()
  const held = whatRuns()
  const running = runningVersion(held)
  const installed = installedVersions(home)
  const front = frontVersion()
  const fallback = defaultRequest(home).request
  // `default` marks the version need.tree resolves to, and nothing when there is no need.tree: the front then runs,
  // and it is marked `front` already
  const byDefault = fallback ? versionOf(chooseFor({ request: fallback, home, running })) : undefined
  const here = versionOf(chooseVersionHere(running))

  for (const version of installed) {
    report({
      glyph: 'info',
      verb: 'list',
      subject: `term ${version}`,
      facts: [
        ...(version === front ? ['front'] : []),
        ...(version === byDefault ? ['default'] : []),
        ...(version === here ? ['runs here'] : []),
        usedFact(version),
      ],
    })
  }

  if (held.form !== 'installed') {
    report({
      glyph: 'info',
      verb: 'list',
      subject: `term ${held.version}`,
      facts: [held.form, ...(held.version === byDefault ? ['default'] : []), ...(held.version === here ? ['runs here'] : [])],
      fields: [location(showPath(payloadRoot()))],
    })
  }

  const total = installed.length + (held.form === 'installed' ? 0 : 1)

  closeRun({
    verdict: total === 0 ? 'No version is installed' : `${total} ${total === 1 ? 'version' : 'versions'} here`,
    facts: fallback ? [`default ${fallback.text}`] : ['no default: the front runs'],
    next: total === 0 ? 'term self load <version>' : undefined,
  })
}

export async function callSelfFind(input: { root: string; range?: string; all?: boolean }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'find' })

  const hold = input.range ? holdOrRefuse(input.range) : undefined

  if (input.range && !hold) {
    return
  }

  const versions = (await releases())?.filter(version => !hold || codeMatch(parseCode(version), hold))

  if (!versions) {
    closeRun({ verdict: 'The releases could not be read', failure: 'environment' })

    return
  }

  const route = routeOf()
  const transport = transportFor({ host: route.registry.host })
  const platform = currentPlatform()
  const installed = installedVersions(userHome())
  const indexes = await Promise.all(versions.map(version => readReleaseIndex({ transport, repository: route.repository.name, version })))
  let shown = 0

  versions.forEach((version, at) => {
    const index = indexes[at]
    const here = !!platform && !!index?.platforms.includes(platform)

    if (!input.all && !here) {
      return
    }

    shown++
    report({
      glyph: 'info',
      verb: 'find',
      subject: `term ${version}`,
      facts: installed.includes(version) ? ['installed'] : [],
      fields: input.all && index ? [field('platforms', index.platforms.join(', '))] : [],
    })
  })

  closeRun({
    verdict: shown === 0 ? `No release${input.range ? ` in ${input.range}` : ''}${input.all ? '' : ` for ${platform ?? 'this platform'}`}` : `${shown} ${shown === 1 ? 'release' : 'releases'}`,
    facts: [`${route.registry.host}/${route.repository.name}`],
    next: shown > 0 ? 'term self load <version>' : undefined,
  })
}

// ---- load, pick, need ----

export async function callSelfLoad(input: { root: string; range: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: `load ${input.range}` })

  const hold = holdOrRefuse(input.range)

  if (!hold) {
    return
  }

  const loaded = await loadVersion(exactOr(input.range, hold))

  if (!reportLoaded(loaded)) {
    closeRun({ verdict: 'Nothing was installed', failure: 'environment' })

    return
  }

  closeRun({ verdict: loaded.fresh ? `Installed ${loaded.version}` : `${loaded.version} was installed already`, done: loaded.fresh, next: `term +${loaded.version} <command>, or term self pick ${loaded.version}` })
}

export async function callSelfPick(input: { root: string; range: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: `pick ${input.range}` })

  const hold = holdOrRefuse(input.range)

  if (!hold) {
    return
  }

  const home = userHome()
  const request: NeedRequest = { source: 'default', text: input.range, hold }
  const choice = chooseFor({ request, home, running: runningVersion(whatRuns()) })

  if (choice.form === 'load') {
    const loaded = await loadVersion(exactOr(input.range, hold))

    if (!reportLoaded(loaded)) {
      closeRun({ verdict: 'The default was not changed', failure: 'environment' })

      return
    }
  }

  const file = nodePath.join(home, 'need.tree')

  writeFileSync(file, [`# The term that runs outside any project. Written by \`term self pick\`.`, `need ${TOOLCHAIN}, mark <${input.range}>`, ''].join('\n'))
  report({ glyph: 'changed', kind: 'change', verb: 'pick', subject: `the default is ${input.range}`, fields: [location(showPath(file))] })
  closeRun({ verdict: `term ${versionOf(chooseFor({ request, home, running: runningVersion(whatRuns()) }))} runs outside a project`, done: true })
}

export async function callSelfNeed(input: { root: string; range?: string; none?: boolean }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: input.none ? 'need --none' : `need ${input.range ?? ''}`.trim() })

  const dir = projectDir(process.cwd())

  if (!dir) {
    report({ glyph: 'failed', kind: 'problem', verb: 'need', subject: 'There is no deck.tree here or above, so there is no project to need a version' })
    closeRun({ verdict: 'Nothing was changed', failure: 'usage', next: 'term self pick <range>, for the default outside a project' })

    return
  }

  const manifest = await loadManifest({ dir })
  const lockfile = await loadLockfile({ dir })
  const manifestFile = nodePath.join(dir, 'deck.tree')

  if (input.none) {
    if (!manifest.need && !lockfile?.need) {
      closeRun({ verdict: 'This project needs no version already' })

      return
    }

    delete manifest.need
    writeFileSync(manifestFile, writeManifest({ manifest }))
    report({ glyph: 'removed', kind: 'change', verb: 'need', subject: TOOLCHAIN, fields: [location(showPath(manifestFile))] })

    if (lockfile?.need) {
      delete lockfile.need
      await saveLockfile({ dir, lockfile })
      report({ glyph: 'removed', kind: 'change', verb: 'pin', subject: TOOLCHAIN, fields: [location(showPath(nodePath.join(dir, 'lock.tree')))] })
    }

    closeRun({ verdict: 'This project runs the default now', done: true })

    return
  }

  if (!input.range) {
    report({ glyph: 'failed', kind: 'problem', verb: 'need', subject: 'term self need takes a version or a range, or --none' })
    closeRun({ verdict: 'Nothing was changed', failure: 'usage', next: 'term self need 2.6.x' })

    return
  }

  const hold = holdOrRefuse(input.range)

  if (!hold) {
    return
  }

  const need = { name: TOOLCHAIN, mark: hold }
  const pinned = await pinNeed({ need, previous: lockfile?.need })

  if (!pinned.pin) {
    report({ glyph: 'failed', kind: 'problem', verb: 'pin', subject: pinned.reason ?? `${TOOLCHAIN} could not be pinned` })
    closeRun({ verdict: 'Nothing was changed', failure: 'environment', next: 'term self find' })

    return
  }

  const version = showCode(pinned.pin.code)
  const loaded = await loadVersion({ version, expect: pinned.pin.hash })

  if (!reportLoaded(loaded)) {
    closeRun({ verdict: 'Nothing was changed', failure: 'environment' })

    return
  }

  manifest.need = need
  writeFileSync(manifestFile, writeManifest({ manifest }))
  report({ glyph: 'changed', kind: 'change', verb: 'need', subject: `${TOOLCHAIN}, mark <${input.range}>`, fields: [location(showPath(manifestFile))] })

  const next: Lockfile = { ...(lockfile ?? { version: 1, decks: [] }), need: pinned.pin }

  await saveLockfile({ dir, lockfile: next })
  report({
    glyph: pinned.kept ? 'skipped' : 'changed',
    kind: 'change',
    verb: 'pin',
    subject: `${TOOLCHAIN} ${version}`,
    facts: pinned.kept ? ['kept'] : [],
    fields: [field('hash', pinned.pin.hash), location(showPath(nodePath.join(dir, 'lock.tree')))],
  })
  closeRun({ verdict: `This project runs term ${version}`, done: true, next: 'commit deck.tree and lock.tree' })
}

// ---- show ----

export async function callSelfShow(input: { root: string; flag?: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: 'show' })

  const held = whatRuns()
  const running = runningVersion(held)
  const home = userHome()
  const world = currentWorld({ argv: input.flag ? [`+${input.flag}`] : [], running })
  const read = readRequest(world)
  const env = world.env['TERM_VERSION']?.trim()
  const project = projectRequest(world.cwd)
  const fallback = defaultRequest(home)
  const source = read.request?.source
  const steps: { rule: string; facts: string[]; fields?: ReturnType<typeof field>[]; hit: boolean }[] = [
    { rule: '1  +flag', facts: [input.flag ? `+${input.flag}` : 'none'], hit: source === 'flag' },
    { rule: '2  TERM_VERSION', facts: [env || 'unset'], hit: source === 'env' },
    {
      rule: '3  project',
      facts: project?.request ? [`need ${TOOLCHAIN}, mark <${project.request.text}>`] : ['no deck.tree here or above names one'],
      fields: project?.request ? [location(`${showPath(project.request.file!)}:${project.request.line ?? 1}`), ...pinFields(project.request, home)] : [],
      hit: source === 'project',
    },
    {
      rule: '4  default',
      facts: fallback.request ? [`need ${TOOLCHAIN}, mark <${fallback.request.text}>`] : ['none'],
      fields: fallback.request ? [location(showPath(fallback.request.file!))] : [],
      hit: source === 'default',
    },
  ]

  for (const step of steps) {
    report({ glyph: step.hit ? 'done' : 'info', verb: 'show', subject: step.rule, facts: step.facts, fields: step.fields ?? [] })

    if (step.hit) {
      break
    }
  }

  if (read.refuse) {
    report({ glyph: 'failed', kind: 'problem', verb: 'show', subject: read.refuse })
    closeRun({ verdict: 'Nothing would run here', failure: 'usage' })

    return
  }

  const choice = chooseFor({ request: read.request, home, running })

  if (!read.request) {
    report({ glyph: 'done', verb: 'show', subject: choice.form === 'run' && choice.by === 'running' ? '6  the running copy' : '5  the newest installed', facts: [] })
  }

  if (choice.form === 'run') {
    const at = choice.launcher ?? nodePath.join(payloadRoot(), 'bin', process.platform === 'win32' ? 'term.cmd' : 'term')

    report({ glyph: 'info', verb: 'show', subject: `term ${choice.version}`, facts: [byFact(choice)], fields: [location(showPath(at))] })
    closeRun({ verdict: `term ${choice.version} runs here` })

    return
  }

  if (choice.form === 'load') {
    const asked = choice.version ?? choice.request.text

    closeRun({ verdict: `term ${asked} is needed here and not installed: the next command installs it`, next: `term self load ${asked}, to install it now` })

    return
  }

  closeRun({ verdict: 'Nothing would run here', failure: 'usage' })
}

// ---- toss, wash ----

export async function callSelfToss(input: { root: string; mark: string }): Promise<void> {
  openRun({ verb: 'self', root: input.root, subject: `toss ${input.mark}` })

  const held = whatRuns()
  const front = frontVersion()

  if (!isInstalled(input.mark)) {
    report({ glyph: 'failed', kind: 'problem', verb: 'toss', subject: `term ${input.mark} is not installed here` })
    closeRun({ verdict: 'Nothing was removed', failure: 'usage', next: 'term self list' })

    return
  }

  if (input.mark === front) {
    report({ glyph: 'failed', kind: 'problem', verb: 'toss', subject: `term ${input.mark} is the front (bin/term)` })
    closeRun({ verdict: 'Nothing was removed', failure: 'usage', next: 'term self back or term self update first' })

    return
  }

  if (held.form === 'installed' && held.install.version === input.mark) {
    report({ glyph: 'failed', kind: 'problem', verb: 'toss', subject: `term ${input.mark} is running this command` })
    closeRun({ verdict: 'Nothing was removed', failure: 'usage' })

    return
  }

  rmSync(userHome('code', input.mark), { recursive: true, force: true })
  report({ glyph: 'removed', kind: 'change', verb: 'toss', subject: `term ${input.mark}`, fields: [location(showPath(userHome('code', input.mark)))] })
  closeRun({ verdict: `Removed ${input.mark}`, done: true })
}

export async function callSelfWash(input: { root: string; days?: number; commit?: boolean }): Promise<void> {
  const days = input.days ?? WASH_DAYS

  openRun({ verb: 'self', root: input.root, subject: 'wash', facts: [`unused ${days} days`, ...(input.commit ? ['--commit'] : [])] })

  const home = userHome()
  const held = whatRuns()
  const running = runningVersion(held)
  const kept = keptVersions({ home, running })
  const cutoff = Date.now() - days * DAY_MS
  let washed = 0

  for (const version of installedVersions(home)) {
    const used = lastUsed(version)

    if (kept.has(version)) {
      // information, not a skipped step: a plan that only lists closes `·`, the glyph of a run that changed nothing
      report({ glyph: 'info', verb: 'keep', subject: `term ${version}`, facts: [kept.get(version)!] })
      continue
    }

    if (used && used.getTime() >= cutoff) {
      continue
    }

    washed++

    if (input.commit) {
      rmSync(userHome('code', version), { recursive: true, force: true })
      report({ glyph: 'removed', kind: 'change', verb: 'wash', subject: `term ${version}`, facts: [usedFact(version, used)] })
    } else {
      report({ glyph: 'info', verb: 'wash', subject: `term ${version}`, facts: [usedFact(version, used), 'would be removed'] })
    }
  }

  closeRun({
    verdict: washed === 0 ? `Nothing unused for ${days} days` : input.commit ? `Removed ${washed}` : `${washed} to remove`,
    counts: [count(washed, 'versions', 'version')],
    done: input.commit && washed > 0,
    next: washed > 0 && !input.commit ? 'term self wash --commit' : undefined,
  })
}

// ---- shared ----

// What is running: an install this layout owns (install.tree beside the payload), a package manager's copy, or a source
// build
function whatRuns(): Held {
  const payload = payloadRoot()
  const install = readInstall(nodePath.join(payload, '..', 'install.tree'))

  if (install) {
    return { form: 'installed', install }
  }

  const version = readPackageVersion(payload)
  const by = managerOf(payload)

  return by ? { form: 'managed', by, version } : { form: 'source', version }
}

/** The package manager that owns the payload at `payload`, by where it put it (task/distro.ts, the Homebrew formula). */
export function managerOf(payload: string, dpkgKnows = existsSync('/var/lib/dpkg/info/term.list')): Manager | undefined {
  if (/[\\/](Caskroom|Cellar)[\\/]/.test(payload)) {
    return 'homebrew'
  }

  if (/[\\/]WinGet[\\/]Packages[\\/]ClueSurf\.Term_/i.test(payload)) {
    return 'winget'
  }

  if (payload === '/usr/lib/term') {
    return dpkgKnows ? 'apt' : 'dnf'
  }

  return undefined
}

// the payload this module was bundled into: host/line.js, one level under it
function payloadRoot(): string {
  return nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..')
}

function runningVersion(held: Held): string {
  return held.form === 'installed' ? held.install.version : held.version
}

function refuseUnmanaged(held: Exclude<Held, { form: 'installed' }>): void {
  const subject =
    held.form === 'managed'
      ? `${SPELLED[held.by]} installed this copy, so ${SPELLED[held.by]} updates it: ${UPDATE[held.by]}`
      : 'This copy is a source build, which is rebuilt, not updated: pnpm run make:line'

  report({ glyph: 'failed', kind: 'problem', verb: 'self', subject })
  closeRun({ verdict: 'Nothing was changed', failure: 'usage' })
}

/** Every released version, newest first, or undefined with the reason reported. */
export async function releases(): Promise<string[] | undefined> {
  try {
    return await listReleases()
  } catch (error) {
    const route = routeOf()

    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'find',
      subject: `The releases at ${route.registry.host}/${route.repository.name} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    })

    return undefined
  }
}

/** One `load` item for an install, or the problem; true when the version is here. */
export function reportLoaded(loaded: Loaded): loaded is Extract<Loaded, { ok: true }> {
  if (!loaded.ok) {
    report({ glyph: 'failed', kind: 'problem', verb: 'load', subject: loaded.reason })

    return false
  }

  if (!loaded.fresh) {
    report({ glyph: 'skipped', verb: 'load', subject: `term ${loaded.version}`, facts: ['installed already'] })

    return true
  }

  report({
    glyph: 'added',
    kind: 'change',
    verb: 'load',
    subject: `term ${loaded.version} for ${loaded.platform}`,
    duration: loaded.duration,
    bytes: loaded.bytes,
    facts: sharedFacts(loaded.shared),
    fields: [field('layer', loaded.layer), field('signed', loaded.keys), location(showPath(installFile(loaded.version)))],
  })

  return true
}

// a range as a person typed it, or a refusal that closes the run
function holdOrRefuse(text: string): CodeHold | undefined {
  try {
    return parseCodeHold(text)
  } catch {
    report({ glyph: 'failed', kind: 'problem', verb: 'self', subject: `${text} is not a version or a range: write 2.6.4, 2.6.x or 2.x.x` })
    closeRun({ verdict: 'Nothing was changed', failure: 'usage' })

    return undefined
  }
}

// an exact version installs exactly; a range installs its newest release
function exactOr(text: string, hold: CodeHold): { version?: string; hold?: CodeHold } {
  return /^\d+\.\d+\.\d+$/.test(text) ? { version: text } : { hold }
}

// the nearest directory holding a deck.tree, walking up
function projectDir(cwd: string): string | undefined {
  let dir = nodePath.resolve(cwd)

  while (true) {
    if (existsSync(nodePath.join(dir, 'deck.tree'))) {
      return dir
    }

    const parent = nodePath.dirname(dir)

    if (parent === dir) {
      return undefined
    }

    dir = parent
  }
}

// What resolution runs in this directory, as a command here would (TERM_VERSION included)
function chooseVersionHere(running: string): NeedChoice {
  const read = readRequest(currentWorld({ argv: [], running }))

  return read.refuse ? { form: 'refuse', reason: read.refuse } : chooseFor({ request: read.request, home: userHome(), running })
}

function versionOf(choice: NeedChoice): string | undefined {
  return choice.form === 'run' ? choice.version : choice.form === 'load' ? choice.version : undefined
}

function byFact(choice: Extract<NeedChoice, { form: 'run' }>): string {
  switch (choice.by) {
    case 'pin':
      return 'pinned in lock.tree'
    case 'running':
      return 'the running copy'
    default:
      return choice.request ? `the newest installed in ${choice.request.text}` : 'the newest installed'
  }
}

// a project's lock.tree pin, as `show` prints it
function pinFields(request: NeedRequest, home: string): ReturnType<typeof field>[] {
  if (!request.pin) {
    return [field('pin', 'none: term load or term self need pins it')]
  }

  const version = showCode(request.pin.code)
  const state = !pinHolds(request)
    ? `stale: ${request.text} excludes it, and term load re-pins it`
    : existsSync(nodePath.join(home, 'code', version, 'install.tree'))
      ? 'installed'
      : 'not installed'

  // the pin's file is always lock.tree beside the deck.tree named above it, so it is said rather than given a second `at`
  return [field('pin', `${version} in lock.tree, ${state}`)]
}

// The versions `wash` never removes, each with why: the front, the running copy, the default's answer, and this
// directory's (its answer and its pin)
function keptVersions(input: { home: string; running: string }): Map<string, string> {
  const kept = new Map<string, string>()
  const add = (version: string | undefined, why: string) => {
    if (version && !kept.has(version)) {
      kept.set(version, why)
    }
  }
  const project = projectRequest(process.cwd())?.request

  add(frontVersion(), 'the front')
  add(input.running, 'running')
  add(versionOf(chooseFor({ request: defaultRequest(input.home).request, home: input.home, running: input.running })), 'the default')
  add(project?.pin ? showCode(project.pin.code) : undefined, 'pinned here')
  add(project ? versionOf(chooseFor({ request: project, home: input.home, running: input.running })) : undefined, 'runs here')

  return kept
}

// `used today`, `used 12 days ago`, `never used`
function usedFact(version: string, used = lastUsed(version)): string {
  if (!used) {
    return 'never used'
  }

  const days = Math.floor((Date.now() - used.getTime()) / DAY_MS)

  return days <= 0 ? 'used today' : days === 1 ? 'used yesterday' : `used ${days} days ago`
}

function readPackageVersion(payload: string): string {
  try {
    return (JSON.parse(readFileSync(nodePath.join(payload, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function compare(a: string, b: string): number {
  return compareCode(parseCode(a), parseCode(b))
}
