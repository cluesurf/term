// The roll from the cache (note/term/plan/incremental-best-in-class.md, step 8). `term make` writes host/roll.json from
// a roll of every entry, each computed from the entry's whole closure. Keyed by the closure key the separate build
// already worked out (every unit key the entry reaches, as one), a warm roll pass is one cache read per entry with no
// walk. It must be the same roll the pass computes without the keys, and it must move when a file does.
// Run: npx tsx test/compile/roll-cache.ts

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSession, compileProjectSeparate } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { projectRoll } from '@term/call/code/roll'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'roll-cache-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/roll\n  mark <0.0.1>\n`)

const helper = join(root, 'code', 'helper.tree')
writeFileSync(
  helper,
  `load @term/base/exception\n  find absence\n\ntask find-one\n  take key, like text\n  like text\n  halt absence\n    bind thing, <a key>\n`,
)
writeFileSync(join(root, 'code', 'base.tree'), `load ./helper\n  find find-one\n\ntask main\n  like text\n  back find-one(<k>)\n`)

const session = buildSession(root)
const built = compileProjectSeparate(root, projectCache(root), 'node', session)
ok('the project builds', built.failed === 0, built.errors.join(' | '))
ok('every program entry has a closure key', built.closures.size === 2, `${built.closures.size}`)

const plain = JSON.stringify(projectRoll(root).roll)
const keyed = JSON.stringify(projectRoll(root, built.closures).roll)
ok('the roll from the keys is the roll without them', keyed === plain)
ok('and names the task and what it raises', keyed.includes('find-one') && keyed.includes('absence'))

// a second keyed pass, in a process that has read nothing: every entry's roll is a cache read
const again = projectRoll(root, built.closures)
ok('a second keyed pass gives the same roll', JSON.stringify(again.roll) === plain)

writeFileSync(join(root, 'code', 'helper.tree'), `${readFileSync(helper, 'utf8')}\ntask find-two\n  like number\n  back 2\n`)

const rebuilt = compileProjectSeparate(root, projectCache(root), 'node', session)
const moved = JSON.stringify(projectRoll(root, rebuilt.closures).roll)
ok('after an edit the closure keys move', rebuilt.closures.get(helper) !== built.closures.get(helper))
ok('and the roll holds the new task', moved.includes('find-two'))
ok('as the roll without the keys does', moved === JSON.stringify(projectRoll(root).roll))

console.log(`\nroll-cache: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
