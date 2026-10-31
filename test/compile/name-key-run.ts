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

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
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

// A FORM TWO FILES DEFINE, REACHED BY NO IMPORT OR BY SEVERAL (decision 091 of term/self-host/change/001-finish-self-host,
// item term-self-host-001-0469). u loads d, d loads a then b, and a and b each define form x (b's with a field m, fall
// 5). u makes x, imported by neither (`unimported`), or found from d whose `bear` chain re-exports both (`several`). The
// binding is the last definer by file name, b's: never the one the walk merged last, which moved when d's two loads
// were swapped while neither of u's keys did, so the incremental build served a's x where a clean build bound b's.
// Each build is a fresh run on one cache; the swapped build must equal a clean build on an empty cache.
function mergeOrderCase(shape: 'unimported' | 'several'): void {
  const top = realpathSync(mkdtempSync(join(tmpdir(), `name-key-order-${shape}-`)))
  mkdirSync(join(top, 'code'), { recursive: true })
  writeFileSync(join(top, 'deck.tree'), `deck @probe/name-key-order\n  mark <0.0.1>\n`)
  const file = (name: string): string => join(top, 'code', `${name}.tree`)
  const head = shape === 'several' ? 'bear' : 'load'
  const dText = (first: string, second: string): string =>
    `${head} ./${first}\n\n${head} ./${second}\n\ntask dee\n  like number\n  back 0\n`
  const uText =
    `load ./d\n  find dee\n${shape === 'several' ? '  find x\n' : ''}\n` +
    `task main\n  like number\n  save v\n    make x\n      bind n, 1\n  back add(v/n, dee())\n`
  writeFileSync(file('a'), `form x\n  link n, like number\n`)
  writeFileSync(file('b'), `form x\n  link n, like number\n  link m, like number, fall 5\n`)
  writeFileSync(file('u'), uText)

  const emit = (into: CompileCache): { ok: boolean; why: string; built: string[]; main: string } => {
    const result = compileSeparate({ file: file('u'), text: uText }, { resolve: projectResolver(top), cache: into, modules: f => `./${f}` })
    if (!result.ok) return { ok: false, why: result.diagnostics.map(d => d.message).join(' | '), built: [], main: '' }
    const own = [...result.modules.entries()].find(([name]) => name.endsWith('/u.tree') || name.includes('_u'))
    const code = own ? own[1].code : [...result.modules.values()].map(m => m.code).join('\n')
    const main = code.slice(code.indexOf('export function main'))
    return { ok: true, why: '', built: result.built.map(l => l.replace(/^.*\/code\//, '')), main }
  }

  writeFileSync(file('d'), dText('a', 'b'))
  const cleanAB = emit(new CompileCache())
  writeFileSync(file('d'), dText('b', 'a'))
  const cleanBA = emit(new CompileCache())
  ok(`${shape}: both load orders build`, cleanAB.ok && cleanBA.ok, `${cleanAB.why} ${cleanBA.why}`)
  ok(`${shape}: both load orders bind b.tree's x, the last by file name`, cleanAB.main.includes('m: 5') && cleanAB.main === cleanBA.main, `${cleanAB.main.slice(0, 120)} | ${cleanBA.main.slice(0, 120)}`)

  const kept = new CompileCache()
  writeFileSync(file('d'), dText('a', 'b'))
  emit(kept)
  writeFileSync(file('d'), dText('b', 'a'))
  const swapped = emit(kept)
  ok(`${shape}: d's loads swapped, the next build equals a clean one`, swapped.ok && swapped.main === cleanBA.main, `${swapped.built.join(', ')} | ${swapped.main.slice(0, 120)}`)
}

mergeOrderCase('unimported')
mergeOrderCase('several')

// THE ORDER IS THE PORTABLE NAMES', NOT THE ABSOLUTE PATHS' (item term-self-host-001-0484, decision 091 section 3). The
// two definers of form x sit under two deck roots, the project @probe/app's (b.tree, with a field m, fall 5) and a linked
// package @probe/lib's (a.tree). u makes x, imported by neither, so it binds the last definer in `group.files` order.
// Sorted by absolute path that order is the roots' directory names, which another clone lays out otherwise: here the
// layout is built twice with the two directory names swapped (`aa-lib` beside `zz-app`, then `aa-app` beside `zz-lib`),
// which flips the absolute order and leaves every portable name (each root written as its deck's token) the same. Both
// builds must bind the same x, @probe/lib's (`@probe/app` sorts first by portable name), and emit the same main.
function twoRootsCase(): void {
  const lay = (appDir: string, libDir: string) => {
    const top = realpathSync(mkdtempSync(join(tmpdir(), 'name-key-roots-')))
    const [app, lib] = [join(top, appDir), join(top, libDir)]
    mkdirSync(join(app, 'code'), { recursive: true })
    mkdirSync(join(lib, 'code'), { recursive: true })
    writeFileSync(join(app, 'deck.tree'), `deck @probe/app\n  mark <0.0.1>\n`)
    writeFileSync(join(lib, 'deck.tree'), `deck @probe/lib\n  mark <0.0.1>\n`)
    writeFileSync(join(lib, 'code', 'a.tree'), `form x\n  link n, like number\n`)
    writeFileSync(join(app, 'code', 'b.tree'), `form x\n  link n, like number\n  link m, like number, fall 5\n`)
    writeFileSync(join(app, 'code', 'd.tree'), `load @probe/lib/a\n\nload ./b\n\ntask dee\n  like number\n  back 0\n`)
    const uText = `load ./d\n  find dee\n\ntask main\n  like number\n  save v\n    make x\n      bind n, 1\n  back add(v/n, dee())\n`
    writeFileSync(join(app, 'code', 'u.tree'), uText)
    const project = projectResolver(app)
    const resolve: Parameters<typeof compileSeparate>[1]['resolve'] = (importPath, fromFile, how) => {
      if (importPath.startsWith('@probe/lib/')) {
        const file = join(lib, 'code', `${importPath.slice('@probe/lib/'.length)}.tree`)
        return { file, text: readFileSync(file, 'utf8') }
      }
      return project(importPath, fromFile, how)
    }
    const deckOf = (file: string) =>
      file.startsWith(`${app}/`) ? { name: '@probe/app', root: app } : file.startsWith(`${lib}/`) ? { name: '@probe/lib', root: lib } : undefined
    const result = compileSeparate(
      { file: join(app, 'code', 'u.tree'), text: uText },
      { resolve, cache: new CompileCache(), modules: f => `./${f}`, deckOf },
    )
    if (!result.ok) return { ok: false, why: result.diagnostics.map(d => d.message).join(' | '), main: '' }
    const own = [...result.modules.entries()].find(([name]) => name.endsWith('/u.tree') || name.includes('_u'))
    const code = own ? own[1].code : [...result.modules.values()].map(m => m.code).join('\n')
    return { ok: true, why: '', main: code.slice(code.indexOf('export function main')) }
  }

  const libFirst = lay('zz-app', 'aa-lib')
  const appFirst = lay('aa-app', 'zz-lib')
  ok('two roots: both layouts build', libFirst.ok && appFirst.ok, `${libFirst.why} ${appFirst.why}`)
  ok(
    "two roots: both layouts bind @probe/lib's x, the last by portable name, and emit one main",
    !libFirst.main.includes('m: 5') && libFirst.main === appFirst.main,
    `${libFirst.main.slice(0, 160)} | ${appFirst.main.slice(0, 160)}`,
  )
}

twoRootsCase()

console.log(`\nname-key-run: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
