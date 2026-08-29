// The tools around a data file: `term form` lays it out canonically with its comments kept, `term lint` reports the
// grammar's rules as findings, `term look` lists its keys, a `role.tree` can name a file data (or not) over what its
// content says, and a compact stream reads one line at a time with re-declarable anchors. The data reader
// (compile/host.ts) is the oracle throughout. Run: npx tsx test/compile/host-tools.ts

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { analyze } from '@term/make/code/analyze'
import { compile } from '@term/make/code/compile/compile'
import {
  dataKeys,
  expandData,
  formatData,
  isCompactTree,
  readDataText,
  readStream,
  writeLong,
} from '@term/make/code/compile/host'
import { projectRoleOf } from '@term/call/code/role-of'

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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const FIXTURE = join(HERE, '../../deck/host/test/fixture')
const fixture = (name: string): string => readFileSync(join(FIXTURE, name), 'utf8')

// ---- form: the canonical layout from the tree ----

for (const name of ['basic.tree', 'anchors.tree', 'basic.line', 'anchors.line', 'stream.line']) {
  const text = fixture(name)
  const tree = parse({ file: name, text })
  ok(`${name} parses`, tree.ok)

  if (tree.ok) {
    ok(`${name} is ${name.endsWith('.line') ? '' : 'not '}compact`, isCompactTree(tree.tree) === name.endsWith('.line'))
    ok(`${name} formats to itself`, formatData(tree.tree, name) === text, formatData(tree.tree, name))
  }
}

// a comment survives, wherever it sits: above an entry, a nested entry, a run of scalars, a mesh, an anchor
const commented = [
  '# the anchor',
  'tree base',
  '  host env, <prod>',
  '',
  '# the service',
  'host x',
  '  # nested',
  '  host y, 1',
  '  list a',
  '    # numbers',
  '    5, 6',
  '  list m',
  '    # first',
  '    mesh',
  '      fuse base',
  '      host n, <a>',
  '',
].join('\n')
const commentedTree = parse({ file: 'c.tree', text: commented })
ok(
  'comments are kept where they were written',
  commentedTree.ok && formatData(commentedTree.tree, 'c.tree') === commented,
  commentedTree.ok ? formatData(commentedTree.tree, 'c.tree') : 'parse failed',
)

// a comment above a compact line stays above it
const compactCommented = '# one\nh(x,1)\n# two\nm(h(y,2))\n'
const compactTree = parse({ file: 'c.line', text: compactCommented })
ok(
  'a compact file keeps its comments',
  compactTree.ok && formatData(compactTree.tree, 'c.line') === '# one\nh(x,1)\n# two\nm(h(y,2))\n',
  compactTree.ok ? formatData(compactTree.tree, 'c.line') : 'parse failed',
)

// a loosely laid out file comes out canonical: the formatter agrees with the writer
const loose = 'host x\n  host y, 1\nlist a\n  5\n  6\nlist m\n  mesh\n    host n, <a>\n'
const looseTree = parse({ file: 'l.tree', text: loose })
const looseRead = readDataText({ file: 'l.tree', text: loose })
ok(
  'a loose layout formats to what the writer gives',
  looseTree.ok && looseRead.ok && formatData(looseTree.tree, 'l.tree') === writeLong(looseRead.data.root),
  looseTree.ok ? formatData(looseTree.tree, 'l.tree') : 'parse failed',
)

// ---- analyze: the editor and CLI path ----

const analysis = analyze({ file: 'basic.tree', text: fixture('basic.tree') })
ok('a data file has no program', analysis.program === null)
ok('a data file has no diagnostics', analysis.diagnostics.length === 0)
ok('a data file formats canonically', analysis.format() === fixture('basic.tree'))
ok('a clean data file has no findings', analysis.lint().length === 0)
ok('a clean data file checks clean', analysis.check().length === 0)

const twice = analyze({ file: 'twice.tree', text: fixture('bad/twice.tree') })
const findings = twice.lint()
ok('a broken data file lints under L031', findings.length > 0 && findings.every(f => f.code === 'L031'), JSON.stringify(findings))
ok(
  'the finding carries the grammar rule',
  findings.some(f => f.message.includes('given twice')),
  findings.map(f => f.message).join(' | '),
)
ok('a broken data file is left as written by form', twice.format() === fixture('bad/twice.tree'))
ok('a broken data file checks with the same message', twice.check().some(d => d.message.includes('given twice')))

const code = analyze({ file: 'go.tree', text: 'task go\n  send back, code 1\n' })
ok('a program still mills', code.program !== null)

// ---- the compile driver and roles ----

const compiled = compile({ file: 'basic.tree', text: fixture('basic.tree') })
ok('a data file compiles to a data module', compiled.ok && compiled.typescript.includes('export default data'))

const asHost = compile({ file: 'basic.tree', text: fixture('basic.tree') }, { roleOf: () => 'host' })
ok('a host role compiles data', asHost.ok && asHost.typescript.includes('export default data'))

const asCode = compile({ file: 'basic.tree', text: fixture('basic.tree') }, { roleOf: () => 'code' })
ok('a code role skips the data reader', !(asCode.ok && asCode.typescript.includes('export default data')))

const constants = 'host x, code 10\n'
const forcedData = compile({ file: 'k.tree', text: constants }, { roleOf: () => 'host' })
ok(
  'a host role on code reports the grammar',
  !forcedData.ok && forcedData.diagnostics.some(d => d.message.includes('is not data')),
  forcedData.ok ? 'compiled' : forcedData.diagnostics.map(d => d.message).join(' | '),
)

const root = mkdtempSync(join(tmpdir(), 'term-role-'))
mkdirSync(join(root, 'data'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), 'deck @probe/role\n  code <0.0.0>\n')
writeFileSync(join(root, 'role.tree'), 'role host\n  take @/data/**/*.tree\n\nrole code\n  take @/code/**/*.tree\n')
const roleOf = projectRoleOf(root)
ok('role.tree names a data file', roleOf(join(root, 'data/config.tree')) === 'host')
ok('role.tree names a code file', roleOf(join(root, 'code/main.tree')) === 'code')
ok('an unlisted file has no role', roleOf(join(root, 'other/x.tree')) === null)

const bare = mkdtempSync(join(tmpdir(), 'term-norole-'))
ok('no role.tree means no role', projectRoleOf(bare)(join(bare, 'x.tree')) === null)

const pointed = mkdtempSync(join(tmpdir(), 'term-role-dir-'))
mkdirSync(join(pointed, 'roles'), { recursive: true })
writeFileSync(join(pointed, 'deck.tree'), 'deck @probe/pointed\n  code <0.0.0>\n  role ./roles\n')
writeFileSync(join(pointed, 'roles/role.tree'), 'role host\n  take @/**/*.tree\n')
ok('the manifest can point at a role directory', projectRoleOf(pointed)(join(pointed, 'any.tree')) === 'host')

// ---- streams ----

const stream = readStream({ file: 'stream.line', text: fixture('stream.line') })
ok('the stream fixture reads', stream.ok && stream.lines === 2)

if (stream.ok) {
  const keys = dataKeys(stream.data)
  ok(
    'the stream expanded its anchor',
    keys.some(k => k.path === 'vars/prod-service/config/env' && k.value === '<prod>'),
    JSON.stringify(keys),
  )
}

const redeclared = readStream({ file: 's.line', text: 't(a,h(x,1))\nh(p,f(a))\n\n# later\nt(a,h(x,2))\nh(q,f(a))\n' })
ok(
  'a later anchor replaces the earlier one from that line on',
  redeclared.ok && writeLong(redeclared.data) === 'host p\n  host x, 1\nhost q\n  host x, 2\n',
  redeclared.ok ? writeLong(redeclared.data) : redeclared.diagnostics.map(d => d.message).join(' | '),
)

const mixed = readStream({ file: 's.line', text: 'h(p,1)\nm(h(x,2))\n' })
ok(
  'a stream that mixes entries and items is refused at the line',
  !mixed.ok && mixed.diagnostics[0]?.span.start.line === 1 && mixed.diagnostics[0].message.includes('never both'),
  mixed.ok ? 'accepted' : mixed.diagnostics.map(d => `${d.span.start.line}: ${d.message}`).join(' | '),
)

const items = readStream({ file: 's.line', text: 'm(h(name,<foo>))\nm(h(name,<bar>))\n' })
ok(
  'a stream of items is a list',
  items.ok && writeLong(items.data) === 'mesh\n  host name, <foo>\nmesh\n  host name, <bar>\n',
  items.ok ? writeLong(items.data) : 'refused',
)

const broken = readStream({ file: 's.line', text: 'h(p,1)\nh(q,f(nothing))\n' })
ok(
  'a fuse of an unknown anchor names its line',
  !broken.ok && broken.diagnostics.some(d => d.message.includes('nothing')),
  broken.ok ? 'accepted' : broken.diagnostics.map(d => d.message).join(' | '),
)

// ---- keys ----

const basic = readDataText({ file: 'basic.tree', text: fixture('basic.tree') })
const expanded = basic.ok ? expandData(basic.data, 'basic.tree') : basic

if (expanded.ok) {
  const keys = dataKeys(expanded.data)
  ok('every key has a row', keys.length === 13, String(keys.length))
  ok('a map row says what it holds', keys.some(k => k.path === 'x' && k.kind === 'map' && k.value === '4 entries'))
  ok('a list item has an index', keys.some(k => k.path === 'x/a/1' && k.value === '6'))
  ok('a text value is written as text', keys.some(k => k.path === 'x/w' && k.value === '<foo>'))
}

console.log(`\nhost-tools: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
