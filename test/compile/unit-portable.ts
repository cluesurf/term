// A portable unit cache (note/term/plan/incremental-best-in-class.md, step 13). A unit's key, its fingerprints and its
// stored answer write each deck's root as a token, so a second clone of the repository at another path reuses what
// the first one built, and reads it back with its own paths. Two clones here, each with its own copy of the standard
// library at a different depth and a project beside it, one store between them.
// Run: npx tsx test/compile/unit-portable.ts

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, compileProjectSeparate } from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'
import { stdlibBase } from '@term/make/code/resolve'

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

const stdlib = stdlibBase()!
const base = realpathSync(mkdtempSync(join(tmpdir(), 'unit-portable-')))
const store = join(base, 'store')
const SKIP = new Set(['host', 'node_modules', '.base', 'tmp', 'link'])

// a clone: the standard library copied under `at`, and a project beside it loading it
const clone = (at: string): { root: string; library: string } => {
  const library = join(base, at, 'base')
  cpSync(stdlib, library, { recursive: true, filter: from => !SKIP.has(from.split('/').pop()!) })

  const root = join(base, at, 'app')
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @probe/portable\n  mark <0.0.1>\n`)
  writeFileSync(join(root, 'code', 'base.tree'), `load @term/base/text\n  find trim\n\ntask main\n  like text\n  back trim(< here >)\n`)

  return { root, library }
}

const build = (one: { root: string; library: string }) => {
  process.env.TERM_STDLIB = one.library

  return compileProjectSeparate(one.root, new CompileCache(diskCacheStore(store, 'portable'), 'portable'), 'node', buildSession(one.root))
}

const emitted = (root: string): string =>
  readdirSync(join(root, 'host', '.unit'))
    .map(name => readFileSync(join(root, 'host', '.unit', name), 'utf8'))
    .join('\n')

const first = clone('first')
const second = clone('second/deeper/still')

const a = build(first)
ok('the first clone builds', a.failed === 0, a.errors.join(' | '))
ok('and builds the standard library units it reaches', a.built > 1, `${a.built} built`)

const b = build(second)
ok('the second clone, at another path, builds', b.failed === 0, b.errors.join(' | '))
// its own project is the same deck with the same text, so its unit is the first clone's too
ok('and builds nothing, reading every unit the first clone built', b.built === 0 && b.reused === a.built + a.reused, `${b.built} built, ${b.reused} read`)
ok('its output names none of the first clone\'s paths', !emitted(second.root).includes(join(base, 'first')))
ok('and the two clones emit the same standard library', emitted(first.root) === emitted(second.root))

console.log(`\nunit-portable: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
