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
//   5  the newest version installed                 under ~/.base/@cluesurf/term/code/
//   6  the running term itself                      a Homebrew or source copy, with nothing installed
//
// THE PARSER READS EVERY FILE. A `deck.tree`, a `lock.tree` and the default are read with `readTree`, never a pattern:
// one parser for `.tree` (note/term/one-parser.md). A cheap test on the text decides only whether to parse at all: a
// manifest with no line starting `need` cannot hold one, so most projects cost one file read.

import { existsSync, readdirSync, readFileSync } from 'fs'
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

  const defaultFile = nodePath.join(world.home, 'need.tree')
  const fallback = needInFile({ file: defaultFile, under: 'root' })

  if (fallback && 'refuse' in fallback) {
    return { refuse: fallback.refuse, argv: flag.argv }
  }

  if (fallback) {
    return { request: { ...fallback, source: 'default' }, argv: flag.argv }
  }

  return { argv: flag.argv }
}

/** Decide, from the request and what is installed. No network: a version that is not here is a `load`. */
export function chooseVersion(world: NeedWorld): { choice: NeedChoice; argv: string[] } {
  const read = readRequest(world)
  const installed = installedVersions(world.home)

  if (read.refuse) {
    return { choice: { form: 'refuse', reason: read.refuse }, argv: read.argv }
  }

  const request = read.request

  if (!request) {
    const newest = installed[0]

    return {
      choice: newest
        ? { form: 'run', version: newest, by: 'installed', launcher: launcherOf({ home: world.home, version: newest }) }
        : { form: 'run', version: world.running, by: 'running' },
      argv: read.argv,
    }
  }

  // a project's pin, while it still satisfies the request, is the exact version
  if (request.pin && request.pin.name === TOOLCHAIN && codeMatch(request.pin.code, request.hold)) {
    const version = showCode(request.pin.code)

    return {
      choice: installed.includes(version)
        ? { form: 'run', version, by: 'pin', request, launcher: launcherOf({ home: world.home, version }) }
        : { form: 'load', version, hold: request.hold, expect: request.pin.hash, request },
      argv: read.argv,
    }
  }

  const here = installed.find(version => codeMatch(parseCode(version), request.hold))

  if (here) {
    return {
      choice: { form: 'run', version: here, by: 'installed', request, launcher: launcherOf({ home: world.home, version: here }) },
      argv: read.argv,
    }
  }

  // the running copy answers too, when it is not under code/ (Homebrew, a source build) and it is in range
  if (codeMatch(parseCode(world.running), request.hold)) {
    return { choice: { form: 'run', version: world.running, by: 'running', request }, argv: read.argv }
  }

  return { choice: { form: 'load', hold: request.hold, request }, argv: read.argv }
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

// The nearest deck.tree, walking up, whose `need` is set, with its directory's lock.tree pin
function projectRequest(cwd: string): { request?: NeedRequest; refuse?: string } | undefined {
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
