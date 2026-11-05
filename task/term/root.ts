// THE TERM ROOT, for every tool under task/term (spec.md section 3 rule 1, decision 004 of note/project/term).
//
// TERM_ROOT is TERM_ROOT from the environment when set, else the nearest folder at or above this file that holds
// task/term/root.ts: the folder two above it where it sits, and the Term root when a test bundle inlines it (a suite
// docks a task/term module by its @term/term package path, decision 121 of change 001, item 0962), as the compiler's
// own modules find their install root. Every tool reads the root from here: nothing joins a fixed folder to the working
// directory, and nothing climbs out of the repository.
//
// CALLER_CWD is the folder the person typed the command in: pnpm sets INIT_CWD to it, and `pnpm --dir` changes the
// working directory to the Term root, so a path the person typed resolves against CALLER_CWD (rule 2).
//
// PARENT_ROOT is the checkout this repository sits inside, for the tools that still read one (zone, mesh, notes). Only
// TERM_PARENT_ROOT names it: every parent alias sets it to the parent root, and nothing guesses it. Unset, it is
// undefined, and:
//   parentRoot()       a tool that needs the parent exits 2, with one line naming the variable
//   parentPaths(...)   a list of roots or packages that includes a parent one leaves it out, so the rest still runs
//   a test that needs it is skipped with that reason (task/term/test.ts `needsEnv`)

import { existsSync } from 'node:fs'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// the nearest folder at or above `from` holding task/term/root.ts, else the folder two above `from`
function rootAbove(from: string): string {
  let dir = from
  while (true) {
    if (existsSync(join(dir, 'task', 'term', 'root.ts'))) return dir
    const up = dirname(dir)
    if (up === dir) return resolve(from, '..', '..')
    dir = up
  }
}

export const TERM_ROOT: string = process.env.TERM_ROOT
  ? resolve(process.env.TERM_ROOT)
  : rootAbove(dirname(fileURLToPath(import.meta.url)))

export const CALLER_CWD: string = process.env.INIT_CWD ?? process.cwd()

export const PARENT_ROOT: string | undefined = process.env.TERM_PARENT_ROOT
  ? resolve(process.env.TERM_PARENT_ROOT)
  : undefined

export function parentRoot(): string {
  if (PARENT_ROOT === undefined) {
    console.error('TERM_PARENT_ROOT is unset: this tool reads the parent checkout, so name it (the parent aliases do)')
    process.exit(2)
  }
  return PARENT_ROOT
}

// each path under the parent, relative to the Term root (so it joins and resolves like a Term path), or none
export function parentPaths(...paths: string[]): string[] {
  return PARENT_ROOT === undefined ? [] : paths.map(path => relative(TERM_ROOT, join(PARENT_ROOT!, path)))
}

// the zone command: TERM_ZONE when set, else `zone` on the PATH. Never a zone checkout reached through the parent.
// Neither there: exit 2, with one line naming TERM_ZONE
export function zoneCommand(): string {
  const named = process.env.TERM_ZONE
  if (named) {
    if (existsSync(named)) return named
    console.error(`TERM_ZONE names ${named}, which is not there`)
    process.exit(2)
  }
  for (const folder of (process.env.PATH ?? '').split(delimiter)) {
    if (folder && existsSync(join(folder, 'zone'))) return 'zone'
  }
  console.error('there is no zone command: set TERM_ZONE to one, or put zone on the PATH')
  process.exit(2)
}
