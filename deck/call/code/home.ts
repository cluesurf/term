// The ONE place the toolchain's directory and environment names are written.
//
// Everything Term keeps on disk lives under `.base/@term/code/`: a project's build cache, its memory, its boot
// markers and logs, and the user-level installs, auth token, link registry and shared caches under `~`. The folder
// is named for the package the toolchain is, `@term/code`.
//
// WHY THIS FILE EXISTS. The path was spelled out in 59 places across 28 files, so renaming it was 59 chances to miss
// one, and a missed one does not fail: it reads an empty cache, or writes a fact into a directory nothing looks in.
//
// THE RENAMES, AND HOW EACH IS SURVIVED:
//
//   .base/term/              until 2026-08-30. Still read, through `keptAt`, for what cannot be rebuilt
//   .base/@cluesurf/term/    until 2026-10-05. MOVED, whole, the first time this version touches it (`settle`), and a
//                            link left in its place, so a shell profile's PATH line, an absolute `bin/term` link and an
//                            older `term` (2.6.x writes the old path) all keep reaching the same files
//   .base/@term/code/        now
//
// A MOVE THAT FAILS IS NOT FATAL. Windows refuses to rename a folder another process holds a file in. Then the old
// folder is used, whole, for the rest of that run, and the next run tries again: nothing is ever split across the two.

import path from 'path'
import os from 'os'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from 'fs'
import * as ignore from '@term/call/code/home-ignore'

// the directory under `.base`, the toolchain package's own name
export const HOME = path.join('@term', 'code')

// the same, as a path inside a `.base` written with forward slashes, for matching against a path or a command line
export const HOME_POSIX = '.base/@term/code'

// the folder it was until 2026-10-05, moved by `settle` and left as a link
export const PREVIOUS_HOME = path.join('@cluesurf', 'term')

// the folder before that, until 2026-08-30, still read for data that cannot be rebuilt
export const LEGACY_HOME = 'term'

// Matches a path inside either name the folder has had, for a reader looking for a marker in a command line or a
// file list (a boot server an older `term` started runs from the old one)
export const ANY_HOME = /[\\/]\.base[\\/]@(?:term[\\/]code|cluesurf[\\/]term)[\\/]/

// `<root>/.base/@term/code/<...parts>`
export function projectHome(root: string, ...parts: string[]): string {
  return path.join(settle(path.join(root, '.base'), root), ...parts)
}

// the same path as it was before 2026-08-30, for a fallback read
export function legacyProjectHome(root: string, ...parts: string[]): string {
  return path.join(root, '.base', LEGACY_HOME, ...parts)
}

// `~/.base/@term/code/<...parts>`: the installs, the auth token, the link registry and the shared caches
export function userHome(...parts: string[]): string {
  const home = settle(path.join(os.homedir(), '.base'))

  settleFront(home)

  return path.join(home, ...parts)
}

// THE FRONT'S FOLDER, `call/`: the one thing on PATH, holding `term` (`term.cmd` on Windows), a link to the version
// that dispatches. It was `bin/` until 2026-10-05, renamed by `settleFront` the way `settle` renames the home: whole,
// with a link left at the old name, so a PATH line naming `bin` still reaches it
export const FRONT = 'call'

// the front's folder before 2026-10-05
export const PREVIOUS_FRONT = 'bin'

/**
 * The front's folder under `home`: `call/`, unless only `bin/` is there, which is the case on Windows while the
 * `term.cmd` running the command holds it open and refuses the rename. The installer runs Node directly, not through
 * `term.cmd`, so the next install renames it.
 */
export function frontDir(home: string = userHome()): string {
  const call = path.join(home, FRONT)
  const bin = path.join(home, PREVIOUS_FRONT)

  return !existsSync(call) && isFolder(bin) ? bin : call
}

// the homes whose front has been settled in this process
const frontSettled = new Set<string>()

// `bin/` to `call/`, once, under one home: a rename and a link back, or nothing at all when the rename is refused
export function settleFront(home: string): void {
  if (frontSettled.has(home)) {
    return
  }

  frontSettled.add(home)

  const bin = path.join(home, PREVIOUS_FRONT)
  const call = path.join(home, FRONT)

  if (isFolder(bin) && !existsSync(call)) {
    try {
      renameSync(bin, call)
    } catch {
      return
    }

    linkBack({ from: bin, to: call })
  }
}

// the same, before 2026-08-30
export function legacyUserHome(...parts: string[]): string {
  return path.join(os.homedir(), '.base', LEGACY_HOME, ...parts)
}

// the folders already settled in this process, each with the home it answered
const settled = new Map<string, string>()

/**
 * The home under `base` (a `.base` folder), after moving `@cluesurf/term` to `@term/code` if this is the first time
 * a version that knows the new name has looked. `project` is the project root when `base` is a project's, whose
 * `.gitignore` is brought along. Asked once per folder per process.
 */
export function settle(base: string, project?: string): string {
  const known = settled.get(base)

  if (known) {
    return known
  }

  const current = path.join(base, HOME)
  const previous = path.join(base, PREVIOUS_HOME)
  let home = current

  if (isFolder(previous)) {
    // the usual case, nothing new yet: one rename. Both there means something wrote the new folder before this ran
    // (the compiler's own scratch, an install by @term/deck), and the old one is merged into it entry by entry
    const moved = existsSync(current) ? mergeHome({ from: previous, to: current }) : moveHome({ from: previous, to: current })

    home = moved || existsSync(current) ? current : previous

    // whenever the new folder is the one in use, a merge that left something behind included: the memory may be in
    // it already
    if (home === current && project) {
      renameIgnoreRules(path.join(project, '.gitignore'))
    }
  }

  settled.set(base, home)

  return home
}

// Every entry of `from` that `to` lacks is renamed into it, folders merged the same way one level down at a time. An
// entry both hold keeps `to`'s: the new folder is the one in use. When `from` is left empty it is replaced by the
// link, and the answer is true. When it is not, it is left as it is, holding only what `to` already had, and `term
// wash` names both folders
function mergeHome(input: { from: string; to: string }): boolean {
  if (!mergeInto(input.from, input.to)) {
    return false
  }

  try {
    rmdirSync(input.from)
  } catch {
    return false
  }

  return linkBack(input)
}

// true when `from` ended empty
function mergeInto(from: string, to: string): boolean {
  let empty = true

  for (const name of readdirSync(from)) {
    const source = path.join(from, name)
    const target = path.join(to, name)

    if (!existsSync(target)) {
      try {
        renameSync(source, target)
        continue
      } catch {
        empty = false
        continue
      }
    }

    if (isFolder(source) && isFolder(target) && mergeInto(source, target)) {
      try {
        rmdirSync(source)
        continue
      } catch {
        // falls through to not empty
      }
    }

    empty = false
  }

  return empty
}

// A real folder, not the link a move leaves behind
function isFolder(file: string): boolean {
  try {
    return lstatSync(file).isDirectory()
  } catch {
    return false
  }
}

// One rename, which is atomic on one filesystem, then a link at the old path. A rename another process blocks
// (EPERM, EBUSY on Windows) answers false and moves nothing. A link that cannot be made (a Windows account that may
// not make one) is skipped: the move stands, and only an older `term` loses its way to the new folder
function moveHome(input: { from: string; to: string }): boolean {
  try {
    mkdirSync(path.dirname(input.to), { recursive: true })
    renameSync(input.from, input.to)
  } catch {
    return false
  }

  return linkBack(input)
}

// the link at the old name, to the new folder
function linkBack(input: { from: string; to: string }): boolean {
  try {
    // a junction on Windows needs no privilege and takes an absolute target; elsewhere a relative link survives the
    // home folder itself being moved
    if (process.platform === 'win32') {
      symlinkSync(input.to, input.from, 'junction')
    } else {
      symlinkSync(path.relative(path.dirname(input.from), input.to), input.from)
    }
  } catch {
    // the move is what matters, see above
  }

  return true
}

// The rules `term wake` writes keep a project's memory in git and everything else under `.base/` out of it, one rule
// per level. Written for the old folder, they would ignore the moved memory, and git would read every remembered fact
// as deleted. So exactly those lines are renamed, and nothing else in the file is touched. Which lines, and when, is
// Term since 2026-10-06, call/code/home-ignore.tree
export const IGNORE_RENAMES: [string, string][] = ignore.ignoreRenames().map(rename => [rename.from, rename.to])

export function renameIgnoreRules(file: string): void {
  let text: string

  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return
  }

  // only the block `term wake` wrote, whole: a file a person wrote with one similar line is theirs
  const renamed = ignore.renamedIgnore(text)

  if (renamed !== '') {
    writeFileSync(file, renamed)
  }
}

// The path to use for something that CANNOT BE REBUILT: a remembered fact, an auth token, a signing key, the link
// registry. If the new location does not exist yet and the old one does, the old one is used, whole. Nothing is
// moved and nothing is split across the two, so a rename cannot lose a file and cannot half-migrate one either.
//
// A cache does NOT go through this. It is regenerated by the next build, and pointing at the old copy would keep a
// stale directory alive forever for no benefit.
export function keptAt(current: string, legacy: string): string {
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

// The environment variables the toolchain reads. `TERM_` since the Seed rename; the `SEED_` spelling is still
// honored so a shell profile that sets one keeps working, and is the only place the old name survives.
//
// NOTE the prefix is `TERM_` and never bare `TERM`, which is the terminal type every POSIX shell already sets.
export function env(name: string): string | undefined {
  return process.env[`TERM_${name}`] ?? process.env[`SEED_${name}`]
}
