// THE SELF-CONTAINED GATE (`pnpm term:self-contained`, decision 004 of the Term project). The Term repository builds,
// tests and releases from a fresh clone anywhere, so nothing in it may name this machine or reach outside its root.
//
//   node --experimental-strip-types task/term/self-contained.ts                    the tracked tree
//   node --experimental-strip-types task/term/self-contained.ts --payload <dir>    a staged release payload
//   node --experimental-strip-types task/term/self-contained.ts --payload <dir> --name oci    the payload's name
//   node --experimental-strip-types task/term/self-contained.ts --write-baseline   lower the tree's baseline
//   node --experimental-strip-types task/term/self-contained.ts --write-baseline --payload <dir>   that payload's
//
// Exit 0 clean, 1 a leak (one line per leak, then one summary line), 2 a usage error.
//
// WHAT FAILS, in the tree and in a payload alike, with no pending pass in a payload:
//   machine      the owner's user name, the owner's checkout folder, a mounted volume (MACHINE_WORDS, VOLUMES)
//   absolute     a path under a user's home folder or the macOS temporary folders, on macOS, Linux or Windows
//                (ABSOLUTE), whose prefix is not on task/term/self-contained.allow
//   home         a path that starts at the home folder (HOME) not on the allow list, and always one into the owner's
//                own home layout (HOME_LAYOUT)
//   climb        a relative path that resolves outside the root (from the file's own folder)
//   symlink      a symlink whose target is absolute or resolves outside the root
// PARENT NAMES (PARENT_NAME: the parent repository's notes, sites and data folders, its own path to this repository,
// and its task folder named from a file outside `task/`, which in the tree counts only while the root has no
// `task/term/` of its own) may only fall. In the tree the count per package (the top folder under deck/, test, task,
// other) may not rise above task/term/self-contained.baseline.json's `parentNames`. In a payload the one count may not
// rise above its entry in the baseline's `payload`, keyed by `--name`, else by the staged folder's own name (none
// there allows none). `--write-baseline` rewrites the counts it read and refuses to raise any.
//
// PENDING. A known leak that waits on a decision is named in the baseline's `pending`, by item, file and a text on
// the line. The tree mode reports it as pending and passes. A payload never gets that pass.
//
// The root is TERM_ROOT, else two folders above this file. The tree is `git ls-files` (tracked, and untracked files
// not ignored) when the root is a git work tree's top, else a walk that skips what the repository ignores. Plain node,
// node built-ins only.

import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type Kind = 'machine' | 'absolute' | 'home' | 'climb' | 'symlink' | 'parent-name'

export type Leak = { file: string; line: number; kind: Kind; text: string }

export type Allow = { pattern: string; reason: string }

export type Pending = { file: string; match: string; reason?: string }

export type Baseline = {
  note?: string
  parentNames: Record<string, number>
  pending: Record<string, Pending[]>
  // parent-name lines allowed per payload, by payload name
  payload: Record<string, number>
}

// the owner's user name and checkout folder, spelled in parts so this file does not hold them
const MACHINE_WORDS = [['lance', 'pollard'].join(''), ['crew', 'cluesurf'].join('/')]
const VOLUMES = /\/Volumes\//

// a home or temporary root of some machine, then the rest of the path
const PATH_END = `[^\\s'"\`<>(),;\\]]*`
const ABSOLUTE = new RegExp(
  [
    `(?<![\\w.@:~-])\\/(?:Users|home)\\/[\\w.@-]+${PATH_END}`,
    `(?<![\\w.@:~-])\\/private\\/var\\b${PATH_END}`,
    `(?<![\\w.@:~-])\\/var\\/folders\\b${PATH_END}`,
    `(?<![\\w])[A-Za-z]:(?:\\\\\\\\|\\\\|\\/)+Users\\b${PATH_END}`,
  ].join('|'),
  'g',
)
// a path from the home folder: the tilde, a slash, and at least one character of path
const HOME_END = `[^\\s'"\`<>(),;\\]]+`
const HOME = new RegExp(`(?<![\\w~])~\\/${HOME_END}`, 'g')
// the owner's own home layout: never allowed
const HOME_LAYOUT = /^~\/(base|Desktop|Downloads|code|git|github|Projects|stone|seedrest|bin|certs|\.optmem|\.claude[\w-]*|Library\/base)(\/|$)/
const PARENT_NAME = /(?<![\w./@-])(task\/term\b|deck\/term\/deck\/term|note\/project\b|note\/term\b|note\/library\b|mesh\/|land\/|base\/import\b)/g
// a run of `../` segments, optionally ending in a bare `..`
const CLIMB_SLASH = /(?<![\w./])((?:\.\.\/)+(?:\.\.(?![\w.]))?[\w@.{}*\-/]*)/g
// path.join(x, '..', '..') style: the quoted `..` arguments
const CLIMB_ARGS = /(['"])\.\.\1(?:\s*,\s*(['"])\.\.\2)*/g

const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|pdf|woff2?|ttf|otf|zip|gz|tgz|zst|tar|wasm|node|dylib|so|dll|exe|jar|class|bin|mp3|wav|ogg|mp4|mov|sqlite|db|keystore|car|a|o)$/i

// both sit beside this file (task/term/ in the Term root), so a TERM_ROOT override is checked by the same lists
export const ALLOW_FILE = 'self-contained.allow'
export const BASELINE_FILE = 'self-contained.baseline.json'

function clip(line: string, at: number): string {
  const start = Math.max(0, at - 50)
  return (start > 0 ? '...' : '') + line.slice(start, start + 140).trim()
}

function outside(root: string, target: string): boolean {
  return target !== root && !target.startsWith(root + path.sep)
}

function readText(file: string): string | undefined {
  if (BINARY_EXT.test(file)) {
    return undefined
  }
  const buffer = readFileSync(file)
  if (buffer.subarray(0, 8000).includes(0)) {
    return undefined
  }
  return buffer.toString('utf8')
}

/** a path token with doubled backslashes (a string literal's escapes) read as single */
function plain(token: string): string {
  return token.replace(/\\\\/g, '\\')
}

/** whether an allow pattern covers the token: the token is the pattern, or goes on past it at a separator */
export function allowed(token: string, allow: Allow[]): boolean {
  const whole = plain(token)
  // a path that ends a sentence in prose: its closing punctuation is not part of it
  const trimmed = whole.replace(/[.,:!?]+$/, '')
  for (const t of trimmed === whole ? [whole] : [whole, trimmed]) {
    for (const { pattern } of allow) {
      const p = pattern.replace(/[\\/]$/, '')
      if (t === p || (t.startsWith(p) && (t[p.length] === '/' || t[p.length] === '\\'))) {
        return true
      }
    }
  }
  return false
}

/** the package a file counts under: the top folder under deck/, test, task or other */
export function packageOf(relative: string): string {
  const parts = relative.split('/')
  if (parts[0] === 'deck' && parts.length > 2) {
    return `deck/${parts[1]}`
  }
  if (parts[0] === 'test' || parts[0] === 'task') {
    return parts[0]
  }
  return 'other'
}

/**
 * Every leak in one file. `relative` is its path from the root, with `/` separators. `taskTerm` says whether the name
 * `task/term` is the parent's: in a payload always (outside `task/`), in the tree only while the root has no
 * `task/term/` of its own, since once the tooling lives here the name is this repository's own folder.
 */
export function scanFile(input: { root: string; file: string; relative: string; allow: Allow[]; taskTerm?: boolean }): Leak[] {
  const { root, file, relative, allow } = input
  const taskTerm = input.taskTerm ?? true
  const leaks: Leak[] = []
  let st
  try {
    st = lstatSync(file)
  } catch {
    return leaks
  }

  if (st.isSymbolicLink()) {
    const target = readlinkSync(file)
    if (path.isAbsolute(target) || outside(root, path.resolve(path.dirname(file), target))) {
      leaks.push({ file: relative, line: 0, kind: 'symlink', text: `-> ${target}` })
    }
    return leaks
  }
  if (!st.isFile()) {
    return leaks
  }
  const text = readText(file)
  if (text === undefined) {
    return leaks
  }
  const dir = path.dirname(file)
  const inTask = relative.startsWith('task/')
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const add = (kind: Kind, at: number) => leaks.push({ file: relative, line: index + 1, kind, text: clip(line, at) })

    const lower = line.toLowerCase()
    const word = MACHINE_WORDS.find(w => lower.includes(w))
    const volumes = VOLUMES.exec(line)
    if (word !== undefined) {
      add('machine', lower.indexOf(word))
    } else if (volumes) {
      add('machine', volumes.index)
    }

    if (line.includes('/') || line.includes('\\')) {
      for (const m of line.matchAll(ABSOLUTE)) {
        if (!allowed(m[0], allow)) {
          add('absolute', m.index ?? 0)
          break
        }
      }
    }

    if (line.includes('~/')) {
      for (const m of line.matchAll(HOME)) {
        if (HOME_LAYOUT.test(m[0]) || !allowed(m[0], allow)) {
          add('home', m.index ?? 0)
          break
        }
      }
    }

    PARENT_NAME.lastIndex = 0
    for (const m of line.matchAll(PARENT_NAME)) {
      if (m[1] === 'task/term' && (inTask || !taskTerm)) {
        continue
      }
      add('parent-name', m.index ?? 0)
      break
    }

    if (line.includes('..')) {
      let at = -1
      for (const m of line.matchAll(CLIMB_SLASH)) {
        if (outside(root, path.resolve(dir, m[1]))) {
          at = m.index ?? 0
          break
        }
      }
      if (at < 0) {
        for (const m of line.matchAll(CLIMB_ARGS)) {
          const count = (m[0].match(/\.\./g) ?? []).length
          if (outside(root, path.resolve(dir, ...Array<string>(count).fill('..')))) {
            at = m.index ?? 0
            break
          }
        }
      }
      if (at >= 0) {
        add('climb', at)
      }
    }
  }
  return leaks
}

// ---------- the file sets ----------

/** whether the repository ignores this folder (the walk used when the root is not a git work tree's top) */
function ignoredDir(relative: string): boolean {
  const parts = relative.split('/')
  const name = parts[parts.length - 1]
  if (['node_modules', '.git', 'tmp', '.base', '.build', '.unit', '.seed', '.term'].includes(name)) {
    return true
  }
  if (parts.length === 1 && ['host', 'hold', 'link'].includes(name)) {
    return true
  }
  if (name !== 'host') {
    return false
  }
  // deck/*/host/, deck/*/test/*/host/, test/**/host/ but a bind/host/, task/dev/bootstrap/host/
  if (parts[0] === 'deck' && (parts.length === 3 || (parts.length === 5 && parts[2] === 'test'))) {
    return true
  }
  if (parts[0] === 'test' && parts[parts.length - 2] !== 'bind') {
    return true
  }
  return relative === 'task/dev/bootstrap/host'
}

function walk(root: string, dir: string, into: string[], skip: (relative: string) => boolean): void {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const at = path.join(dir, entry.name)
    const relative = path.relative(root, at).split(path.sep).join('/')
    if (entry.isDirectory()) {
      if (!skip(relative)) {
        walk(root, at, into, skip)
      }
    } else if (entry.isSymbolicLink() && skip(relative)) {
      // a link where the repository ignores a folder (a node_modules linked in) is that folder, and ignored
      continue
    } else {
      into.push(relative)
    }
  }
}

function gitTop(root: string): boolean {
  try {
    const top = execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return realpathSync(top) === realpathSync(root)
  } catch {
    return false
  }
}

/** The tree's files, relative to the root: tracked and untracked-not-ignored, without tmp/ and node_modules */
export function treeFiles(root: string): { files: string[]; source: 'git' | 'walk' } {
  if (gitTop(root)) {
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
    const files = [...new Set(out.split('\0').filter(Boolean))].filter(f => !f.split('/').some(part => part === 'tmp' || part === 'node_modules'))
    return { files, source: 'git' }
  }
  const files: string[] = []
  walk(root, root, files, ignoredDir)
  return { files, source: 'walk' }
}

/** Every file in a payload folder, relative to it */
export function payloadFiles(root: string): string[] {
  const files: string[] = []
  walk(root, root, files, () => false)
  return files
}

// ---------- the allow list and the baseline ----------

export function readAllow(file: string): Allow[] {
  if (!existsSync(file)) {
    return []
  }
  const allow: Allow[] = []
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (line.trim() === '' || line.startsWith('#')) {
        return
      }
      const tab = line.indexOf('\t')
      if (tab <= 0 || line.slice(tab + 1).trim() === '') {
        throw new UsageError(`${file}:${index + 1}: an allow line is a pattern, a tab, then the reason`)
      }
      allow.push({ pattern: line.slice(0, tab).trim(), reason: line.slice(tab + 1).trim() })
    })
  return allow
}

export function readBaseline(file: string): Baseline {
  if (!existsSync(file)) {
    return { parentNames: {}, pending: {}, payload: {} }
  }
  let read: Partial<Baseline>
  try {
    read = JSON.parse(readFileSync(file, 'utf8')) as Partial<Baseline>
  } catch (error) {
    throw new UsageError(`${file}: not JSON (${(error as Error).message})`)
  }
  return { note: read.note, parentNames: read.parentNames ?? {}, pending: read.pending ?? {}, payload: read.payload ?? {} }
}

/** parent-name lines counted per package */
export function countParentNames(leaks: Leak[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const leak of leaks) {
    if (leak.kind === 'parent-name') {
      const key = packageOf(leak.file)
      counts[key] = (counts[key] ?? 0) + 1
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

/** the pending item a tree leak waits on, if the baseline names one */
function pendingFor(leak: Leak, baseline: Baseline): string | undefined {
  for (const [item, list] of Object.entries(baseline.pending)) {
    if (list.some(p => p.file === leak.file && leak.text.includes(p.match))) {
      return item
    }
  }
  return undefined
}

export class UsageError extends Error {}

// ---------- the run ----------

const FAILS: Kind[] = ['machine', 'absolute', 'home', 'climb', 'symlink']

export function scanAll(root: string, files: string[], allow: Allow[], taskTerm: boolean): Leak[] {
  const leaks: Leak[] = []
  for (const relative of files) {
    leaks.push(...scanFile({ root, file: path.join(root, relative), relative, allow, taskTerm }))
  }
  return leaks
}

/** whether `task/term` names the parent's folder in this tree: only while the root has none of its own */
export function taskTermIsParent(root: string): boolean {
  return !existsSync(path.join(root, 'task', 'term'))
}

function show(leak: Leak, label: string = leak.kind): string {
  return `${leak.line > 0 ? `${leak.file}:${leak.line}` : leak.file}: ${label}: ${leak.text}`
}

function tally(leaks: Leak[]): string {
  return FAILS.map(kind => `${kind} ${leaks.filter(l => l.kind === kind).length}`).join(', ')
}

function usage(message: string): never {
  throw new UsageError(
    `${message}\nusage: node --experimental-strip-types task/term/self-contained.ts [--payload <dir> [--name <name>]] [--write-baseline]`,
  )
}

export function main(argv: string[]): number {
  const started = Date.now()
  const here = path.dirname(new URL(import.meta.url).pathname)
  const root = path.resolve(process.env.TERM_ROOT ?? path.join(here, '..', '..'))
  let payload: string | undefined
  let name: string | undefined
  let writeBaseline = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--payload' || arg === '--name') {
      const given = argv[++i]
      if (!given || given.startsWith('--')) {
        usage(arg === '--payload' ? '--payload takes a folder' : '--name takes a payload name')
      }
      if (arg === '--payload') {
        payload = path.resolve(process.env.INIT_CWD ?? process.cwd(), given)
      } else {
        name = given
      }
    } else if (arg === '--write-baseline') {
      writeBaseline = true
    } else {
      usage(`unknown argument '${arg}'`)
    }
  }
  if (name !== undefined && !payload) {
    usage('--name names a payload, so it goes with --payload')
  }
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    usage(`no Term root at ${root}`)
  }
  const allow = readAllow(path.join(here, ALLOW_FILE))
  const seconds = () => ((Date.now() - started) / 1000).toFixed(1)
  const baselineFile = path.join(here, BASELINE_FILE)
  const baseline = readBaseline(baselineFile)

  if (payload) {
    if (!existsSync(payload) || !statSync(payload).isDirectory()) {
      usage(`no payload folder at ${payload}`)
    }
    // the payload's name keys its parent-name count: --name, else the staged folder's own name
    const key = name ?? path.basename(payload)
    const files = payloadFiles(payload)
    const leaks = scanAll(payload, files, allow, true)
    const failing = leaks.filter(l => l.kind !== 'parent-name')
    const parents = leaks.filter(l => l.kind === 'parent-name')
    const allowed = baseline.payload[key] ?? 0

    if (writeBaseline) {
      if (key in baseline.payload && parents.length > allowed) {
        console.log(`payload ${key}: parent-name: ${parents.length} lines, above the baseline's ${allowed}: refused`)
        return 1
      }
      const next: Baseline = { ...baseline, payload: { ...baseline.payload, [key]: parents.length } }
      writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n')
      console.log(`term self-contained: wrote ${baselineFile}: payload ${key}, ${parents.length} parent-name lines`)
      return 0
    }

    for (const leak of failing) {
      console.log(show(leak))
    }
    // a rise lists every parent-name line, so the new one can be found among them
    const rise = parents.length > allowed
    if (rise) {
      for (const leak of parents) {
        console.log(show(leak))
      }
      console.log(`payload ${key}: parent-name: ${parents.length} lines, above the baseline's ${allowed}`)
    }
    const bad = failing.length + (rise ? 1 : 0)
    console.log(
      `term self-contained: payload ${key} ${payload}: ${files.length} files, ${bad} leaks (${tally(failing)}, ` +
        `parent-name ${parents.length} of ${allowed} allowed${rise ? ', a rise' : ''}), ${seconds()}s`,
    )
    return bad > 0 ? 1 : 0
  }
  const { files, source } = treeFiles(root)
  const leaks = scanAll(root, files, allow, taskTermIsParent(root))
  const counts = countParentNames(leaks)

  if (writeBaseline) {
    const raised = Object.entries(counts).filter(([key, n]) => existsSync(baselineFile) && n > (baseline.parentNames[key] ?? 0))
    for (const [key, n] of raised) {
      console.log(`${key}: parent-name: ${n} lines, above the baseline's ${baseline.parentNames[key] ?? 0}: refused`)
    }
    if (raised.length > 0) {
      console.log(`term self-contained: --write-baseline refused, ${raised.length} packages would rise`)
      return 1
    }
    const next: Baseline = { ...baseline, parentNames: counts }
    writeFileSync(baselineFile, JSON.stringify(next, null, 2) + '\n')
    const total = Object.values(counts).reduce((a, b) => a + b, 0)
    console.log(`term self-contained: wrote ${baselineFile}: ${total} parent-name lines in ${Object.keys(counts).length} packages`)
    return 0
  }

  const failing: Leak[] = []
  const pending: { leak: Leak; item: string }[] = []
  for (const leak of leaks) {
    if (leak.kind === 'parent-name') {
      continue
    }
    const item = pendingFor(leak, baseline)
    if (item) {
      pending.push({ leak, item })
    } else {
      failing.push(leak)
    }
  }
  for (const leak of failing) {
    console.log(show(leak))
  }
  const rises = Object.entries(counts).filter(([key, n]) => n > (baseline.parentNames[key] ?? 0))
  for (const [key, n] of rises) {
    console.log(`${key}: parent-name: ${n} lines, above the baseline's ${baseline.parentNames[key] ?? 0}`)
  }
  for (const { leak, item } of pending) {
    console.log(show(leak, `pending ${item}`))
  }
  const falls = Object.entries(baseline.parentNames).filter(([key, n]) => (counts[key] ?? 0) < n).length
  const total = Object.values(counts).reduce((a, b) => a + b, 0)
  const bad = failing.length + rises.length
  console.log(
    `term self-contained: tree ${root} (${source}): ${files.length} files, ${bad} leaks (${tally(failing)}, parent-name rises ${rises.length}), ` +
      `${pending.length} pending, ${total} parent-name lines` +
      (falls > 0 ? `, ${falls} packages below the baseline (--write-baseline lowers it)` : '') +
      `, ${seconds()}s`,
  )
  return bad > 0 ? 1 : 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`term self-contained: ${error.message}`)
      process.exitCode = 2
    } else {
      throw error
    }
  }
}
