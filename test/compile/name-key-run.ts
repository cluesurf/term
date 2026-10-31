// A unit's name-level store key is a function of the unit's own preimage, never of the run that worked it out (item
// term-self-host-001-0452). A unit built first in its own run (an entry, a document or a test request) must be served,
// once its surface key moves, by the name key a later run that reaches it as an import works out, as long as no name it
// reaches changed. Its key used to list the reached definitions' fingerprints in the run's unit order, and two
// independent dependencies are numbered in another order by another entry's walk, so the importer's run worked out
// another key and built the unit again.
//
// x.tree loads a.tree then b.tree (independent of each other). y.tree loads b.tree, then x.tree. A build of x stores
// x's unit; a task nobody names is added to a.tree (x's surface key moves, its name key must not); a build of y must
// then build a.tree and y.tree only, never x.tree.
//
// Each build is a fresh run (no unit memo) against one cache, as successive `term make` runs are.
// Run: npx tsx test/compile/name-key-run.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'

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

// the real path, so the entry's own file and the resolver's answer for it are one text (macOS's /var is /private/var)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'name-key-run-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/name-key-run\n  mark <0.0.1>\n`)

const at = (name: string): string => join(root, 'code', `${name}.tree`)
const aText = `task alpha\n  take n, like number\n  like number\n  back n\n`
const bText = `task beta\n  take n, like number\n  like number\n  back n\n`
const xText = `load ./a\n  find alpha\n\nload ./b\n  find beta\n\ntask both\n  take n, like number\n  like number\n  back alpha(beta(n))\n`
const yText = `load ./b\n  find beta\n\nload ./x\n  find both\n\ntask main\n  like number\n  back beta(both(1))\n`
writeFileSync(at('a'), aText)
writeFileSync(at('b'), bText)
writeFileSync(at('x'), xText)
writeFileSync(at('y'), yText)

const cache = new CompileCache()

const build = (entry: string, text: string) => {
  const result = compileSeparate({ file: at(entry), text }, { resolve: projectResolver(root), cache, modules: f => `./${f}` })
  if (!result.ok) return { ok: false as const, why: result.diagnostics.map(d => d.message).join(' | '), built: [] as string[] }
  // by the file's own name: the resolver answers a load by its real path, `/private/var` where the test wrote `/var`
  const built = result.built.map(label => label.split('+').map(one => one.replace(/^.*\/code\//, '')).join('+'))
  return { ok: true as const, why: '', built }
}

const first = build('x', xText)
ok('x builds as its own entry', first.ok, first.why)
ok('and builds a, b and x', first.ok && first.built.length === 3, first.built.join(', '))

writeFileSync(at('a'), `${aText}\ntask unused\n  like number\n  back 7\n`)

const importer = build('y', yText)
ok('y builds after a task nobody names is added to a.tree', importer.ok, importer.why)
ok('and rebuilds a.tree', importer.built.includes('a.tree'), importer.built.join(', '))
ok(
  "and serves x.tree from the answer x's own run stored (its name key is the run's own)",
  !importer.built.includes('x.tree'),
  importer.built.join(', '),
)

const again = build('y', yText)
ok('an unchanged build of y builds nothing', again.ok && again.built.length === 0, again.built.join(', '))

console.log(`\nname-key-run: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
