// Which `term` runs here, and why (note/term/plan/term-versions.md, "Resolution").
//
// Every command asks this first, from `host/need.mjs` before the CLI loads, so it reads only small files and imports
// only the parser: no registry, no network. Its answer is one of three things: RUN a version that is here, LOAD one
// first (a pin or a range nothing installed satisfies), or REFUSE, naming why. Installing is somebody else's job
// (`need-load.ts`), so this stays cheap enough to run on every command.
//
// THE ORDER, first match wins, the one rustup, elan and Go converged on:
//
//   1  `+<range>`, the first argument               this command alone
//   2  TERM_VERSION                                 every command that sees it
//   3  the nearest deck.tree holding a `need`       its lock.tree's pin while the pin still satisfies it
//   4  ~/.base/@cluesurf/term/need.tree             the user's default, from `term self pick`
//   5  the front, bin/term                          the version `update`, `back` and the loader moved it to
//      else the newest version installed            under ~/.base/@cluesurf/term/code/
//   6  the running term itself                      a Homebrew or source copy, with nothing installed
//
// THE RUNNING COPY COUNTS AS INSTALLED in rules 3 to 5. A Homebrew `term` 2.6.6 in a project that needs 2.6.x runs
// itself rather than handing over to an older 2.6.4 under code/, and on a tie it wins, because it costs no handoff.
//
// THE PARSER READS EVERY FILE. A `deck.tree`, a `lock.tree` and the default are read with `readTree`, never a pattern:
// one parser for `.tree` (note/term/one-parser.md). A cheap test on the text decides only whether to parse at all: a
// manifest with no line starting `need` cannot hold one, so most projects cost one file read.

import { existsSync, readdirSync, readFileSync, readlinkSync, statSync, writeFileSync } from 'fs'
import nodePath from 'path'

import { codeMatch, compareCode, parseCode, parseCodeHold, showCode } from '@term/deck/code/code'
import { formOf, readTree, valueOf, type Form } from '@term/deck/code/read'
import type { CodeHold, LockNeed } from '@term/deck/code/form'

import { userHome } from '@term/call/code/home'

/** The one package a `need` may name today. */
export const TOOLCHAIN = '@term/code'

/** A file's text could hold a `need` line. Only decides whether to parse; the parser decides what it says. */
const MIGHT_NEED = /^[ \t]*need[ \t]/m

const VERSION = /^\d+\.\d+\.\d+$/

// a version's `used` stamp is rewritten at most this often, so recording a use costs nothing per command
const USED_EVERY_MS = 24 * 60 * 60 * 1000

/** Where a request came from, in the order above. */
export type NeedSource = 'flag' | 'env' | 'project' | 'default' | 'installed' | 'running'

/** A request for a version: a range, where it was written, and the project's pin beside it. */
export type NeedRequest = {
  source: NeedSource
  // the range as written: `2.6.x`, `2.6.4`
  text: string
  hold: CodeHold
  // the file and line it was read from (project and default)
  file?: string
  line?: number
  // the project's lock.tree pin, when one is there
  pin?: LockNeed
  pinFile?: string
}

/** What to do. */
export type NeedChoice =
  | {
      form: 'run'
      version: string
      // how the version was chosen within the request
      by: 'pin' | 'installed' | 'running'
      request?: NeedRequest
      // the installed payload's launcher, or undefined when the running copy is the answer
      launcher?: string
    }
  | {
      form: 'load'
      // an exact version to install (a pin), or a range to resolve against the releases
      version?: string
      hold: CodeHold
      // the index digest the pin requires
      expect?: string
      request: NeedRequest
    }
  | { form: 'refuse'; reason: string; request?: NeedRequest }

/** What resolution reads, gathered so a test can hand in its own. */
export type NeedWorld = {
  argv: string[]
  env: NodeJS.ProcessEnv
  cwd: string
  // ~/.base/@cluesurf/term
  home: string
  // the running term's version
  running: string
}

/** The world as this process sees it. */
export function currentWorld(input: { argv: string[]; running: string }): NeedWorld {
  return { argv: input.argv, env: process.env, cwd: process.cwd(), home: userHome(), running: input.running }
}

/**
 * The `+<range>` argument, split off. `term +2.6.x make` is a request for `2.6.x` and the arguments `make`. A first
 * argument that is not a `+` followed by a version is an ordinary argument and stays.
 */
export function splitFlag(argv: string[]): { text?: string; argv: string[] } {
  const first = argv[0]

  if (first && first.startsWith('+') && /^\+\d/.test(first)) {
    return { text: first.slice(1), argv: argv.slice(1) }
  }

  return { argv }
}

/** Every installed version, newest first: the directories under code/ that hold an install.tree. */
export function installedVersions(home: string): string[] {
  const code = nodePath.join(home, 'code')

  if (!existsSync(code)) {
    return []
  }

  return readdirSync(code)
    .filter(name => VERSION.test(name) && existsSync(nodePath.join(code, name, 'install.tree')))
    .sort((a, b) => compareCode(parseCode(b), parseCode(a)))
}

/**
 * The version the front (bin/term) points at, or undefined when there is no front under this home. A symlink read with
 * `readlink`, or on Windows the one-line `bin\term.cmd` shim, which names its version's folder.
 */
export function frontOf(home: string): string | undefined {
  try {
    const text =
      process.platform === 'win32'
        ? readFileSync(nodePath.join(home, 'bin', 'term.cmd'), 'utf8')
        : readlinkSync(nodePath.join(home, 'bin', 'term'))

    return /code[\\/](\d+\.\d+\.\d+)[\\/]/.exec(text)?.[1]
  } catch {
    return undefined
  }
}

/** The launcher of an installed version: `bin/term`, or `bin\term.cmd` on Windows. */
export function launcherOf(input: { home: string; version: string }): string {
  return nodePath.join(input.home, 'code', input.version, 'term', 'bin', process.platform === 'win32' ? 'term.cmd' : 'term')
}

/**
 * The request in force, by the order above, or undefined when none is written anywhere (rules 5 and 6 then decide).
 * Throws nothing: a request that does not parse becomes a refusal the caller prints.
 */
export function readRequest(world: NeedWorld): { request?: NeedRequest; argv: string[]; refuse?: string } {
  const flag = splitFlag(world.argv)

  if (flag.text !== undefined) {
    return holdOf({ source: 'flag', text: flag.text, argv: flag.argv })
  }

  const env = world.env['TERM_VERSION']?.trim()

  if (env) {
    return holdOf({ source: 'env', text: env, argv: flag.argv })
  }

  const project = projectRequest(world.cwd)

  if (project) {
    return { ...project, argv: flag.argv }
  }

  return { ...defaultRequest(world.home), argv: flag.argv }
}

/** Decide, from the request and what is installed. No network: a version that is not here is a `load`. */
export function chooseVersion(world: NeedWorld): { choice: NeedChoice; argv: string[] } {
  const read = readRequest(world)

  if (read.refuse) {
    return { choice: { form: 'refuse', reason: read.refuse }, argv: read.argv }
  }

  return { choice: chooseFor({ request: read.request, home: world.home, running: world.running }), argv: read.argv }
}

/**
 * What one request runs, given what is here: rules 3 to 6 once the request is known. `term self list` and `wash` ask
 * it of the default, and `show` of every rule, so they can never disagree with dispatch.
 */
export function chooseFor(input: { request?: NeedRequest; home: string; running: string }): NeedChoice {
  const { request, home, running } = input
  const installed = installedVersions(home)
  // what can run without a download: everything installed, and the running copy, which may not be under code/ (a
  // Homebrew or source copy). Newest first, and on a tie the running copy, which costs no handoff
  const here = [...new Set([...installed, running])].sort((a, b) => compareCode(parseCode(b), parseCode(a)))
  const runOf = (version: string, by: 'pin' | 'installed' | 'running'): NeedChoice =>
    version === running && !installed.includes(version)
      ? { form: 'run', version, by: by === 'pin' ? 'pin' : 'running', ...(request ? { request } : {}) }
      : { form: 'run', version, by, ...(request ? { request } : {}), launcher: launcherOf({ home, version }) }

  // rule 5: the front, so `term self back` and `update` mean what they say and `term self load` switches nothing
  if (!request) {
    const front = frontOf(home)

    return runOf(front && here.includes(front) ? front : here[0]!, 'installed')
  }

  // a project's pin, while it still satisfies the request, is the exact version
  if (pinHolds(request)) {
    const version = showCode(request.pin!.code)

    return here.includes(version)
      ? runOf(version, 'pin')
      : { form: 'load', version, hold: request.hold, expect: request.pin!.hash, request }
  }

  const match = here.find(version => codeMatch(parseCode(version), request.hold))

  return match ? runOf(match, 'installed') : { form: 'load', hold: request.hold, request }
}

/** Does the request's lock.tree pin still satisfy it? A pin outside the range is stale, and `term load` re-pins it. */
export function pinHolds(request: NeedRequest): boolean {
  return !!request.pin && request.pin.name === TOOLCHAIN && codeMatch(request.pin.code, request.hold)
}

/** The user's default, `need.tree` under the home, written by `term self pick`. */
export function defaultRequest(home: string): { request?: NeedRequest; refuse?: string } {
  const found = needInFile({ file: nodePath.join(home, 'need.tree'), under: 'root' })

  if (!found) {
    return {}
  }

  return 'refuse' in found ? { refuse: found.refuse } : { request: { ...found, source: 'default' } }
}

/** Record that a command ran on a version today, so `term self wash` keeps it. At most one write a day, never a failure. */
export function markUsed(input: { home: string; version: string }): void {
  const file = nodePath.join(input.home, 'code', input.version, 'used')

  try {
    if (!existsSync(nodePath.join(input.home, 'code', input.version, 'install.tree'))) {
      return
    }

    if (existsSync(file) && Date.now() - statSync(file).mtimeMs < USED_EVERY_MS) {
      return
    }

    writeFileSync(file, `${new Date().toISOString()}\n`)
  } catch {
    // a read-only home must never stop a command
  }
}

// A request from text: a range in the constraint syntax a `link` uses
function holdOf(input: { source: NeedSource; text: string; argv: string[] }): { request?: NeedRequest; argv: string[]; refuse?: string } {
  try {
    return { request: { source: input.source, text: input.text, hold: parseCodeHold(input.text) }, argv: input.argv }
  } catch {
    const where = input.source === 'flag' ? `+${input.text}` : `TERM_VERSION=${input.text}`

    return { refuse: `${where} is not a version or a range: write 2.6.4, 2.6.x or 2.x.x`, argv: input.argv }
  }
}

/** The nearest deck.tree, walking up, whose `need` is set, with its directory's lock.tree pin. */
export function projectRequest(cwd: string): { request?: NeedRequest; refuse?: string } | undefined {
  let dir = nodePath.resolve(cwd)

  while (true) {
    const manifest = nodePath.join(dir, 'deck.tree')
    const found = existsSync(manifest) ? needInFile({ file: manifest, under: 'deck' }) : undefined

    if (found && 'refuse' in found) {
      return { refuse: found.refuse }
    }

    if (found) {
      const lockFile = nodePath.join(dir, 'lock.tree')
      const pin = existsSync(lockFile) ? pinInLock(lockFile) : undefined

      return {
        request: { ...found, source: 'project', ...(pin ? { pin, pinFile: lockFile } : {}) },
      }
    }

    const parent = nodePath.dirname(dir)

    if (parent === dir) {
      return undefined
    }

    dir = parent
  }
}

// `need @term/code, mark <2.6.x>` in a file: under the `deck` form of a manifest, or at the top of the default file
function needInFile(input: {
  file: string
  under: 'deck' | 'root'
}): Omit<NeedRequest, 'source'> | { refuse: string } | undefined {
  let text: string

  try {
    text = readFileSync(input.file, 'utf8')
  } catch {
    return undefined
  }

  if (!MIGHT_NEED.test(text)) {
    return undefined
  }

  const read = readTree({ file: input.file, text })

  if (!read.ok) {
    return { refuse: `${input.file} does not parse: ${read.diagnostics[0]?.message ?? 'a syntax error'}` }
  }

  const holder: Form | undefined =
    input.under === 'deck' ? read.forms.find(form => form.head === 'deck') : undefined
  const need = holder ? formOf(holder, 'need') : read.forms.find(form => form.head === 'need')

  if (!need) {
    return undefined
  }

  const name = need.terms[0]
  const mark = valueOf(need, 'mark')
  const line = lineOf(text)

  if (name !== TOOLCHAIN) {
    return { refuse: `${input.file}:${line}: need names ${name ?? 'nothing'}, and only ${TOOLCHAIN} can be needed` }
  }

  if (!mark) {
    return { refuse: `${input.file}:${line}: need ${TOOLCHAIN} names no version: write need ${TOOLCHAIN}, mark <2.6.x>` }
  }

  try {
    return { text: mark, hold: parseCodeHold(mark), file: input.file, line }
  } catch {
    return { refuse: `${input.file}:${line}: mark <${mark}> is not a version or a range` }
  }
}

// The `need` pin in a lock.tree, read with the parser
function pinInLock(file: string): LockNeed | undefined {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }

  if (!MIGHT_NEED.test(text)) {
    return undefined
  }

  const read = readTree({ file, text })
  const form = read.ok ? read.forms.find(one => one.head === 'need') : undefined
  const code = form ? valueOf(form, 'code') : undefined
  const hash = form ? valueOf(form, 'hash') : undefined

  if (!form?.terms[0] || !code || !hash || !VERSION.test(code)) {
    return undefined
  }

  return { name: form.terms[0], code: parseCode(code), hash }
}

// The line a `need` sits on, for a person to find it. Display only: the parser already decided what it says
function lineOf(text: string): number {
  const at = text.search(MIGHT_NEED)

  return at < 0 ? 1 : text.slice(0, at).split('\n').length
}
