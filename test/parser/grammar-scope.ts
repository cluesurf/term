// GRAMMAR SCOPES in the parser (parser/token.tree `scope-at`, note/term/mill/02-role-scopes.md): the stretch after
// `role <name>`, or after a name the file's loads import as a grammar, is handed over WHOLE as one literal that
// remembers how it was written. Held here: where each spelling's literal lands in the tree, its text verbatim, what
// is NOT a scope (a file's role, a `find`, a use of the name as a variable, a literal already written), the one
// refusal (parentheses left open), and that `term form` writes every spelling back exactly as it was written.
// Run: npx tsx test/parser/grammar-scope.ts

import { parse, printTree } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import { formatReport } from '@term/make/code/format/format'

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

const LOAD = 'load @term/mill/text/note\n  find note\n\n'

// the tree as a line: a group is `(...)`, a name its text, a scope `{spelling:text}`, a literal `<text>`
function shape(node: Node): string {
  const n = node as {
    kind: string
    nodes?: Node[]
    parts?: { kind: string; text?: string }[]
    raw?: string
    scope?: string
    value?: number
  }

  switch (n.kind) {
    case 'group':
      return `(${n.nodes!.map(shape).join(' ')})`
    case 'name':
      return n.parts!.map(p => p.text ?? '').join('')
    case 'text':
      return n.scope ? `{${n.scope}:${n.raw}}` : `<${n.parts!.map(p => p.text ?? '').join('')}>`
    default:
      return String(n.value)
  }
}

function tree(text: string): string {
  const parsed = parse({ file: 'scope.tree', text })

  if (!parsed.ok) {
    return `NOT OK: ${parsed.diagnostics.map(d => d.message).join(' | ')}`
  }

  return (parsed.tree as { nodes: Node[] }).nodes.map(shape).join(' ')
}

// the last top-level group, past the load
function last(text: string): string {
  const parsed = parse({ file: 'scope.tree', text })

  if (!parsed.ok) {
    return `NOT OK: ${parsed.diagnostics.map(d => d.message).join(' | ')}`
  }

  const nodes = (parsed.tree as { nodes: Node[] }).nodes

  return shape(nodes[nodes.length - 1]!)
}

// ---- where each spelling lands ----

ok('`role note, x + y` is a sibling of the name', tree('a x, role note, x + y') === '(a (x) (role (note) {line:x + y}))', tree('a x, role note, x + y'))
ok('`role note x + y` nests under the name', tree('a x, role note x + y') === '(a (x) (role (note {line:x + y})))', tree('a x, role note x + y'))
ok('`role note(x + y)` in parentheses', tree('a role note(f(x) + y)') === '(a (role (note {paren:f(x) + y})))', tree('a role note(f(x) + y)'))
ok(
  '`role note` over a block, its lines dedented and kept',
  tree('a x\n  role note\n    x^2\n      + 1\n\nb') === '(a (x) (role (note {block:x^2\n  + 1}))) (b)',
  JSON.stringify(tree('a x\n  role note\n    x^2\n      + 1\n\nb')),
)
ok('an imported name: `note x + y`', last(`${LOAD}a x, note x + y`) === '(a (x) (note {line:x + y}))', last(`${LOAD}a x, note x + y`))
ok('an imported name in parentheses: `note(x + y)`', last(`${LOAD}a note(x + y)`) === '(a (note {paren:x + y}))', last(`${LOAD}a note(x + y)`))
ok('an imported name over a block', last(`${LOAD}note\n  9.81m/s^2`) === '(note {block:9.81m/s^2})', last(`${LOAD}note\n  9.81m/s^2`))
ok('an alias: `find note, name math`', last('load @term/mill/text/note\n  find note, name math\n\na math 1 + 2') === '(a (math {line:1 + 2}))')
ok('a relative mill: `load ./some/mill`', last('load ./some/mill\n  find note\n\na note 1 + 2') === '(a (note {line:1 + 2}))')
ok('`find role note` under any load', last('load ./x\n  find role note\n\na note 1 + 2') === '(a (note {line:1 + 2}))')
ok('the text is verbatim: `.tree` never reads it', tree('a role note, {x} \\ <y> # z') === '(a (role (note) {line:{x} \\ <y> # z}))', tree('a role note, {x} \\ <y> # z'))
ok('trailing spaces are not the scope\'s', tree('a role note, x + y   ') === '(a (role (note) {line:x + y}))', JSON.stringify(tree('a role note, x + y   ')))

// ---- what is not a scope ----

ok('`role mill` is a file\'s role, never a scope', tree('role mill\n  take @/code/**') === '(role (mill) (take (@/code/**)))')
ok(
  'a `role` heading an unindented line is a role rule, whatever it names, so a misspelling is still refused as a role',
  tree('role special\n  take @/code/**') === '(role (special) (take (@/code/**)))',
  tree('role special\n  take @/code/**'),
)
ok('`find role note` itself is a load line', !tree('load ./x\n  find role note').includes('{'))
ok('the name used as a variable: `save note, 3`, `read note`', !last(`${LOAD}save note, 3\nread note`).includes('{'))
ok('a literal already written: `note <A sentence.>`', last(`${LOAD}note <A sentence.>`) === '(note <A sentence.>)')
ok('without the import, `note` is code', !tree('a note x').includes('{'))
ok('`find` of a code module is not a grammar: `load @term/base/list / find get`', !last('load @term/base/list\n  find get\n\na get x').includes('{'))

// ---- refused ----

const open = parse({ file: 'scope.tree', text: `${LOAD}a note(x + 1` })

ok(
  'parentheses left open are refused, at the `(`',
  !open.ok && open.diagnostics.some(d => /must close with `\)` on the same line/.test(d.message) && d.span.start.line === 3 && d.span.start.column === 6),
  JSON.stringify(open.diagnostics.map(d => [d.message, d.span.start])),
)

// ---- written back as written ----

const WRITTEN = [
  'task f\n  take x, like number\n  like number\n  send back, role note, x + 1\n',
  'task f\n  take x, like number\n  like number\n  send back, role note(x * (x + 1))\n',
  'task f\n  take x, like number\n  like number\n  send back\n    role note\n      x^2\n        + 1\n',
  `${LOAD}task f\n  take x, like number\n  like number\n  send back, note x - 1\n`,
  `${LOAD}task f\n  take x, like number\n  like number\n  send back, note(x * 2)\n`,
  `${LOAD}task f\n  take x, like number\n  like number\n  note total = x * 3\n  send back, read total\n`,
]

// the lines a scope is written on, as written: its opener's line and, for a block, the lines under it
function scopeLines(text: string): string[] {
  const lines = text.split('\n')
  const at = lines.findIndex(line => /role note|note [^<]|note\(/.test(line) && !/find/.test(line))
  const own = lines[at]!.length - lines[at]!.trimStart().length
  const out = [lines[at]!]

  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== '' && line.length - line.trimStart().length <= own) {
      break
    }

    out.push(line)
  }

  return out.filter(line => line.trim() !== '')
}

for (const text of WRITTEN) {
  const report = formatReport({ file: 'scope.tree', text })
  const want = scopeLines(text).join('\n')
  const again = formatReport({ file: 'scope.tree', text: report.text })

  ok(
    `term form keeps the meaning and writes the scope as written: ${JSON.stringify(scopeLines(text)[0]!.trim())}`,
    report.refused === undefined && report.text.includes(want) && again.text === report.text,
    `\n${report.text}\nrefused: ${report.refused}`,
  )
}

ok(
  'the canonical printer writes a scope as the literal it reads the same as',
  printTree(parse({ file: 'scope.tree', text: 'a role note, x + y' }).tree) === 'a\n  role\n    note\n    <<x + y>>',
  JSON.stringify(printTree(parse({ file: 'scope.tree', text: 'a role note, x + y' }).tree)),
)

ok(
  'and that literal parses back to the same scope',
  tree('a\n  role\n    note\n    <<x + y>>') === '(a (role (note) <x + y>))',
  tree('a\n  role\n    note\n    <<x + y>>'),
)

console.log(`\ngrammar-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
