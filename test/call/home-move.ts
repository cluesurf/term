// `.base/@cluesurf/term` becomes `.base/@term/code` (deck/call/code/home.ts `settle`), in every state a machine can be
// found in, and through the shipped CLI:
//
//   the usual case: the folder moved whole, a link left at the old name, every file reachable by both names
//   a project's `.gitignore` written by `term wake`: its five rules renamed and nothing else; one a person wrote, alone
//   both folders there (something wrote the new one first): merged entry by entry, the new copy kept on a clash
//   a move the filesystem refuses: the old folder used whole, nothing split, and the next run tries again
//   asked twice: the second answer is the first, and nothing moves again
//   the CLI: `term --version` with a home holding only the old folder leaves it moved, and `term bind` finds the token
//
// Run: npx tsx test/call/home-move.ts
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frontDir, settle, settleFront } from '@term/call/code/home'
import { GITIGNORE } from '@term/call/code/wake-text'

const LINE = join(import.meta.dirname, '..', '..', 'host', 'line.js')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'term-home-move-'))
}

// the block `term wake` wrote before 2026-10-05
const OLD_IGNORE = GITIGNORE.replace(/@term\/code/g, '@cluesurf/term').replace(/@term\//g, '@cluesurf/')

// ---- the usual case ----

{
  const root = scratch()
  const base = join(root, '.base')
  const old = join(base, '@cluesurf', 'term')

  mkdirSync(join(old, 'memory'), { recursive: true })
  writeFileSync(join(old, 'memory', 'index.md'), '- a fact\n')
  writeFileSync(join(old, 'auth'), 'ws-token\n')
  writeFileSync(join(root, '.gitignore'), OLD_IGNORE)

  const home = settle(base, root)

  ok('the folder moves to .base/@term/code', home === join(base, '@term', 'code') && readFileSync(join(home, 'auth'), 'utf8') === 'ws-token\n')
  ok('a link is left at the old name', lstatSync(old).isSymbolicLink() && readlinkSync(old) === join('..', '@term', 'code'))
  ok('every file reads the same through the old name', readFileSync(join(old, 'memory', 'index.md'), 'utf8') === '- a fact\n')
  ok("the project's .gitignore keeps the moved memory in git", readFileSync(join(root, '.gitignore'), 'utf8') === GITIGNORE, readFileSync(join(root, '.gitignore'), 'utf8'))
  ok('asked again, the same answer and nothing moves', settle(base, root) === home)
}

// ---- the front's folder, bin/ to call/ ----

{
  const home = scratch()

  mkdirSync(join(home, 'bin'), { recursive: true })
  writeFileSync(join(home, 'bin', 'term'), '#!/bin/sh\n')
  settleFront(home)

  ok('the front moves from bin/ to call/', readFileSync(join(home, 'call', 'term'), 'utf8') === '#!/bin/sh\n')
  ok('   a link is left at bin/, so a PATH line naming it still runs term', lstatSync(join(home, 'bin')).isSymbolicLink() && existsSync(join(home, 'bin', 'term')))
  ok('   frontDir answers call/', frontDir(home) === join(home, 'call'))
}

{
  const home = scratch()

  mkdirSync(join(home, 'bin'), { recursive: true })
  ok('a home not settled yet: frontDir answers bin/, the folder that exists', frontDir(home) === join(home, 'bin'))

  const empty = scratch()

  ok('a home with neither: frontDir answers call/, where the installer will put it', frontDir(empty) === join(empty, 'call'))
}

// ---- a .gitignore a person wrote ----

{
  const root = scratch()
  const base = join(root, '.base')
  const theirs = 'node_modules\n.base/@cluesurf/term/*\n'

  mkdirSync(join(base, '@cluesurf', 'term'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), theirs)
  settle(base, root)

  ok('a .gitignore that is not the wake block is left as it is', readFileSync(join(root, '.gitignore'), 'utf8') === theirs)
}

// ---- both folders there ----

{
  const root = scratch()
  const base = join(root, '.base')
  const old = join(base, '@cluesurf', 'term')
  const current = join(base, '@term', 'code')

  mkdirSync(join(old, 'memory'), { recursive: true })
  mkdirSync(join(old, 'tmp'), { recursive: true })
  writeFileSync(join(old, 'memory', 'index.md'), '- the old fact\n')
  writeFileSync(join(old, 'tmp', 'clash'), 'old\n')
  mkdirSync(join(current, 'tmp'), { recursive: true })
  writeFileSync(join(current, 'tmp', 'clash'), 'new\n')

  const home = settle(base, root)

  ok('both there: what only the old folder held is moved in', home === current && readFileSync(join(current, 'memory', 'index.md'), 'utf8') === '- the old fact\n')
  ok('both there: on a clash the new copy is kept', readFileSync(join(current, 'tmp', 'clash'), 'utf8') === 'new\n')
  ok('both there: the old folder, left holding only clashes, stays a folder', lstatSync(old).isDirectory() && existsSync(join(old, 'tmp', 'clash')) && !existsSync(join(old, 'memory')))
}

{
  const root = scratch()
  const base = join(root, '.base')
  const old = join(base, '@cluesurf', 'term')

  mkdirSync(join(old, 'memory'), { recursive: true })
  writeFileSync(join(old, 'memory', 'index.md'), '- a fact\n')
  mkdirSync(join(base, '@term', 'code', 'tmp'), { recursive: true })
  settle(base, root)

  ok('both there with no clash: the old folder empties and becomes the link', lstatSync(old).isSymbolicLink())
}

// ---- a move the filesystem refuses ----

if (process.platform !== 'win32' && process.getuid?.() !== 0) {
  const root = scratch()
  const base = join(root, '.base')
  const old = join(base, '@cluesurf', 'term')

  mkdirSync(old, { recursive: true })
  writeFileSync(join(old, 'auth'), 'ws-token\n')
  // a rename needs to write both parents; `.base/@cluesurf` read-only refuses it, as a held file does on Windows
  chmodSync(join(base, '@cluesurf'), 0o555)

  const home = settle(base, root)

  ok('a refused move uses the old folder, whole', home === old && readFileSync(join(home, 'auth'), 'utf8') === 'ws-token\n')
  ok('   and nothing was split into the new one', !existsSync(join(base, '@term', 'code')))
  chmodSync(join(base, '@cluesurf'), 0o755)
}

// ---- the shipped CLI ----

if (existsSync(LINE)) {
  const home = scratch()
  const old = join(home, '.base', '@cluesurf', 'term')

  mkdirSync(join(old, 'bin'), { recursive: true })
  writeFileSync(join(old, 'auth'), 'ws-cli\n')
  writeFileSync(join(old, 'bin', 'term'), '#!/bin/sh\n')
  // a command that reads the user folder, so both renames happen: the folder, then its front
  execFileSync(process.execPath, [LINE, 'self', 'list', '--plain'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', stdio: 'pipe' })

  const current = join(home, '.base', '@term', 'code')

  ok('the CLI moves the user folder on its first run', readFileSync(join(current, 'auth'), 'utf8') === 'ws-cli\n' && lstatSync(old).isSymbolicLink())
  ok('   and its front, bin/ to call/', existsSync(join(current, 'call', 'term')) && lstatSync(join(current, 'bin')).isSymbolicLink())
  ok('   the old PATH entry still reaches the front, through both links', readFileSync(join(old, 'bin', 'term'), 'utf8') === '#!/bin/sh\n')
} else {
  console.log('skip  the CLI moves the user folder: host/line.js is not built (pnpm run make:line)')
}

console.log(`\nhome-move: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
