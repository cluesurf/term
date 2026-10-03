// A package path resolves inside the package's CODE ROOT first, then its package root, and `base <dir>` under a
// load forces the package root (note/term/plan/manifest-mark-and-code-root.md). This holds the plan's resolution
// table as fixtures, `base` with a match and a mismatch, the `ambiguous-load` warning, `{platform}` slots in both
// roots, relative loads, a bare package path, and the manifest's `mark` and `code`, old spelling included.
//
// Every assertion goes through the functions the build calls: `resolvePackagePath` (the rule), `projectResolver`
// (the build's resolver, the one the language server and `term look` ask), `withNativeEnv`, `compile`, and the
// lint and manifest readers. Run: npx tsx test/compile/code-root.ts

import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { codeRootOf, resolvePackagePath } from '@term/make/code/resolve'
import { projectResolver } from '@term/call/code/make'
import { withNativeEnv } from '@term/make/code/compile/native'
import { collectModules } from '@term/make/code/compile/load'
import { compile } from '@term/make/code/compile/compile'
import { ambiguousLoads, manifestFindings } from '@term/call/code/lint'
import { parseManifest } from '../../deck/deck/code/manifest'

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

function write(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const task = (name: string, said: string): string => `task ${name}\n  like text\n\n  send back, text <${said}>\n`

// ---- the plan's layout, twice: A has `code/code/foo.tree` and `code/view/x.tree`, B has neither ----
//
//   ./
//     code/
//       code/foo.tree      (A only)
//       foo.tree           (B only)
//       make/bar.tree
//       task/bar.tree
//       view/x.tree        (A only)
//     make/bar.tree
//     task/bar.tree
//     view/x.tree

function makePackage(withShadow: boolean): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'term-code-root-')))
  write(root, 'deck.tree', 'deck @fixture/site\n  mark <0.0.2>\n')
  write(root, 'code/make/bar.tree', task('bar', 'code root'))
  write(root, 'code/task/bar.tree', task('bar', 'code root task'))
  write(root, 'make/bar.tree', task('bar', 'package root'))
  write(root, 'task/bar.tree', task('bar', 'package root task'))
  write(root, 'view/x.tree', task('x', 'package view'))
  write(root, 'code/base.tree', task('entry', 'entry'))

  if (withShadow) {
    write(root, 'code/code/foo.tree', task('foo', 'code code'))
    write(root, 'code/view/x.tree', task('x', 'code view'))
  } else {
    write(root, 'code/foo.tree', task('foo', 'code'))
  }

  return root
}

const a = makePackage(true)
const b = makePackage(false)
const rel = (root: string, file: string | undefined): string => (file ? file.slice(root.length + 1) : 'nothing')

// ---- 1. the table ----

const table: [string, string, string, string][] = [
  // load, package, expected, why
  ['code/foo', a, 'code/code/foo.tree', 'the code root holds a `code/` folder'],
  ['code/foo', b, 'code/foo.tree', 'else the package root'],
  ['make/bar', a, 'code/make/bar.tree', 'the code root first'],
  ['task/bar', a, 'code/task/bar.tree', 'the code root first'],
  ['view/x', a, 'code/view/x.tree', 'the code root when it holds the path'],
  ['view/x', b, 'view/x.tree', 'else the package root'],
]

for (const [path, root, expected, why] of table) {
  const hit = resolvePackagePath({ dir: root, rest: path })
  ok(`@fixture/site/${path} -> ./${expected} (${why})`, rel(root, hit.file) === expected, rel(root, hit.file))
}

// the build's own resolver agrees, from a file inside the package (its own name, no `link/`)
{
  const resolve = projectResolver(a)
  const from = join(a, 'code', 'main.tree')

  for (const [path, root, expected] of table.filter(row => row[1] === a)) {
    const found = resolve(`@fixture/site/${path}`, from)
    ok(`projectResolver: @fixture/site/${path} -> ./${expected}`, rel(root, found?.file) === expected, rel(root, found?.file))
  }

  const entry = resolve('@fixture/site', from)
  ok('a bare package path names its entry, the code root\'s base.tree', rel(a, entry?.file) === 'code/base.tree', rel(a, entry?.file))

  const local = resolve('@/make/bar', from)
  ok('`@/make/bar` (this package) follows the same rule', rel(a, local?.file) === 'code/make/bar.tree', rel(a, local?.file))
}

// ---- 2. `base <dir>` ----

{
  const forced = resolvePackagePath({ dir: a, rest: 'make/bar', base: 'make' })
  ok('`base make` resolves from the package root', rel(a, forced.file) === 'make/bar.tree', rel(a, forced.file))

  const wrong = resolvePackagePath({ dir: a, rest: 'make/bar', base: 'task' })
  ok(
    'a `base` that is not the first segment is refused, naming both',
    wrong.file === undefined && /base task/.test(wrong.refused ?? '') && /`make`/.test(wrong.refused ?? ''),
    JSON.stringify(wrong),
  )

  const resolve = projectResolver(a)
  const from = join(a, 'code', 'main.tree')
  const viaBuild = resolve('@fixture/site/make/bar', from, { base: 'make' })
  ok('projectResolver honors `base`', rel(a, viaBuild?.file) === 'make/bar.tree', rel(a, viaBuild?.file))

  // end to end, through the mill: `base` is a child of the load beside `find`, and it imports nothing
  const main = `load @fixture/site/make/bar\n  base make\n  find bar\n\ntask main\n  like text\n\n  send back, call bar\n`
  write(a, 'code/main.tree', main)

  const modules = collectModules({ file: from, text: main }, resolve)
  const files = modules.sources.map(source => rel(a, source.file))
  ok('the build loads the package root\'s file under `base make`', files.includes('make/bar.tree') && !files.includes('code/make/bar.tree'), files.join(' '))

  const built = compile({ file: from, text: main }, { resolve })
  ok('a load with `base` compiles', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '))

  const mismatch = `load @fixture/site/make/bar\n  base task\n  find bar\n`
  const refused = compile({ file: from, text: mismatch }, { resolve })
  const said = refused.ok ? '' : refused.diagnostics.map(d => d.message).join(' | ')
  ok('a mismatched `base` fails the build at the load, naming both', !refused.ok && /base task/.test(said) && /`make`/.test(said), said)
}

// ---- 3. the ambiguity warning ----

{
  const resolve = projectResolver(a)
  const from = join(a, 'code', 'main.tree')
  const text = 'load @fixture/site/make/bar\n  find bar\n'
  const found = ambiguousLoads(text, from, resolve)
  ok(
    '`ambiguous-load` warns on a path both roots hold, naming both files',
    found.length === 1 &&
      found[0]!.code === 'L052' &&
      found[0]!.severity === 'warning' &&
      found[0]!.message.includes(join(a, 'code/make/bar.tree')) &&
      found[0]!.message.includes(join(a, 'make/bar.tree')),
    JSON.stringify(found),
  )

  ok('`base` silences it', ambiguousLoads('load @fixture/site/make/bar\n  base make\n  find bar\n', from, resolve).length === 0)

  ok('one root only: no warning', ambiguousLoads('load @fixture/site/code/foo\n  find foo\n', join(b, 'code', 'main.tree'), projectResolver(b)).length === 0)
}

// ---- 4. `{platform}` and the abstract fallback, in both roots, in the old order ----

{
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'term-code-root-native-')))
  write(root, 'deck.tree', 'deck @fixture/native\n  mark <0.0.2>\n')
  write(root, 'code/native/node/thing.tree', task('thing', 'code node'))
  write(root, 'native/browser/thing.tree', task('thing', 'package browser'))
  write(root, 'code/native/thing.tree', task('thing', 'code abstract'))
  const from = join(root, 'code', 'main.tree')
  const path = '@fixture/native/native/{platform}/thing'

  const node = withNativeEnv('node', projectResolver(root, 'node'))(path, from)
  ok('{platform}: the env\'s own module, in the code root', rel(root, node?.file) === 'code/native/node/thing.tree', rel(root, node?.file))

  const cloudflare = projectResolver(root, 'cloudflare')(path, from)
  ok('{platform}: the borrowed env (cloudflare -> browser), in the package root', rel(root, cloudflare?.file) === 'native/browser/thing.tree', rel(root, cloudflare?.file))

  const rust = projectResolver(root, 'rust')(path, from)
  ok('{platform}: no env has one, so the abstract module beside the env dirs', rel(root, rust?.file) === 'code/native/thing.tree', rel(root, rust?.file))
}

// ---- 5. relative loads are unchanged ----

{
  write(b, 'code/near.tree', task('near', 'near'))
  const found = projectResolver(b)('./near', join(b, 'code', 'main.tree'))
  ok('a relative load resolves beside its file', rel(b, found?.file) === 'code/near.tree', rel(b, found?.file))

  const up = projectResolver(b)('../make/bar', join(b, 'code', 'main.tree'))
  ok('`../x` resolves against the file, never the code root', rel(b, up?.file) === 'make/bar.tree', rel(b, up?.file))
}

// ---- 6. the manifest: `mark`, `code ./src`, and the old spelling ----

{
  const old = 'deck @fixture/old\n  code <1.4.2>\n  link @fixture/site, code <0.0.x>\n'
  const read = parseManifest({ text: old })
  ok('`code <1.4.2>` still reads as the version', read.mark.major === 1 && read.mark.minor === 4 && read.mark.patch === 2)

  const warned = manifestFindings(old, 'deck.tree')
  ok(
    '`code <version>` warns (`manifest-code-version`), once per old spelling, each with a fix',
    warned.length === 2 && warned.every(f => f.rule === 'manifest-code-version' && f.severity === 'warning' && f.fix?.text === 'mark'),
    JSON.stringify(warned),
  )

  const src = realpathSync(mkdtempSync(join(tmpdir(), 'term-code-root-src-')))
  const manifest = 'deck @fixture/src\n  mark <1.4.2>\n  code ./src\n'
  write(src, 'deck.tree', manifest)
  write(src, 'src/foo.tree', task('foo', 'src'))
  write(src, 'code/foo.tree', task('foo', 'not the code root'))

  const parsed = parseManifest({ text: manifest })
  ok('`mark <1.4.2>` is the version and `code ./src` the code root', parsed.mark.patch === 2 && parsed.code === './src')
  ok('`code ./src` reads as the code root', codeRootOf(src) === 'src', codeRootOf(src))
  ok('a manifest with `mark` and `code` raises no warning', manifestFindings(manifest, 'deck.tree').length === 0)

  const hit = resolvePackagePath({ dir: src, rest: 'foo' })
  ok('a package path resolves in `./src`, never the default `./code`', rel(src, hit.file) === 'src/foo.tree', rel(src, hit.file))

  const bear = realpathSync(mkdtempSync(join(tmpdir(), 'term-code-root-bear-')))
  write(bear, 'deck.tree', 'deck @fixture/bear\n  code <0.0.2>\n  bear ./lib\n')
  ok('`bear ./lib`, the old spelling, still names the code root', codeRootOf(bear) === 'lib', codeRootOf(bear))
  const versioned = realpathSync(mkdtempSync(join(tmpdir(), 'term-code-root-version-')))
  write(versioned, 'deck.tree', 'deck @fixture/versioned\n  code <0.0.2>\n')
  ok('a version written `code <0.0.2>` is never taken for a folder', codeRootOf(versioned) === 'code', codeRootOf(versioned))
}

console.log(`\ncode-root: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
