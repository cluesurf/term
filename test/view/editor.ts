// The editor sees a document the same way a save does.
//
// `analyze` is what the language server calls per keystroke. Without the role it mills a document as code and
// underlines every `view` line as an undefined name, which is both wrong and the opposite of helpful. With it,
// the editor calls the SAME gate the compiler and `term view` call, so it can never be more permissive than a
// save, and never more strict.

import { analyze } from '@term/make/code/analyze'
import { readCatalog } from '@term/make/code/compile/view-catalog'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0

function ok(what: string, held: boolean, note = ''): void {
  if (held) {
    pass++
    console.log(`ok    ${what}`)
  } else {
    fail++
    console.log(`FAIL  ${what}  ${note}`)
  }
}

const DOCUMENT = `
host title, text <Vowels>

view page
  view text/heading
    bind text, read title
`

const asCode = analyze({ file: 'page.tree', text: DOCUMENT })
const asView = analyze({ file: 'page.tree', text: DOCUMENT }, { role: 'view' })

ok('without the role it is milled as code', asCode.kind === 'code')
ok('with the role it is a document', asView.kind === 'view')
ok('and the document has no diagnostics', asView.diagnostics.length === 0, JSON.stringify(asView.diagnostics.map(d => d.message)))
ok('and it lowers to a program', asView.program !== null && asView.program.length === 1)
ok(
  'the same text as code has none of that',
  asCode.program === null || asCode.program.length !== 1 || asCode.diagnostics.length > 0,
)

// a fault is underlined with a span, per keystroke, and it is the SAME message a save gives
const bad = analyze({ file: 'page.tree', text: 'view page\n  task main\n' }, { role: 'view' })

ok('a fault is reported', bad.diagnostics.length > 0)
ok(
  'with the message a save would give',
  bad.diagnostics.some(d => /cannot declare a function/.test(d.message)),
  bad.diagnostics.map(d => d.message).join(' | '),
)
ok('and a span to underline', bad.diagnostics.every(d => d.span !== undefined))

// the editor takes the catalog too, so an unregistered name is underlined while typing rather than at save
const HERE = dirname(fileURLToPath(import.meta.url))
const loaded = readCatalog({ file: 'catalog.tree', text: readFileSync(join(HERE, 'catalog.tree'), 'utf8') })

if (loaded.ok) {
  const off = analyze(
    { file: 'page.tree', text: 'view page\n  view text/nowhere\n    bind a, text <x>\n' },
    { role: 'view', catalog: loaded.catalog },
  )

  ok(
    'an unregistered component is underlined while typing',
    off.diagnostics.some(d => /not a component this document may place/.test(d.message)),
    off.diagnostics.map(d => d.message).join(' | '),
  )

  const on = analyze(
    { file: 'page.tree', text: 'view page\n  view text/heading\n    bind a, text <x>\n' },
    { role: 'view', catalog: loaded.catalog },
  )

  ok('a registered one is not', on.diagnostics.length === 0, on.diagnostics.map(d => d.message).join(' | '))
}

// a document formats, because it IS tree syntax and the formatter needs no role
const messy = analyze({ file: 'page.tree', text: 'view page\n  view text/item\n    bind a,   text <x>\n\n\n' }, { role: 'view' })

ok('a document formats', messy.format() === 'view page\n  view text/item\n    bind a, text <x>\n', JSON.stringify(messy.format()))

ok('and carries no code-role lint findings', messy.lint().length === 0)

// ---- the language server's own path ----
// The server runs an IncrementalAnalyzer, a per-definition query compiler rather than `compile`. A document takes
// an early return out of it: it is read by the same gate, and the incremental machinery buys it nothing because
// its imports are catalog packages with no cross-module checking to do.

const { IncrementalAnalyzer } = await import('@term/make/code/compile/analyzer')

const asDoc = new IncrementalAnalyzer(undefined, () => 'view')
const asProgram = new IncrementalAnalyzer(undefined, () => null)

const good = await asDoc.analyze({ file: 'page.tree', text: DOCUMENT })

ok('the server path reads a document', good.diagnostics.length === 0, JSON.stringify(good.diagnostics.map(d => d.message)))
ok('and hands back its lowered program', good.program?.length === 1 && good.program[0]?.form === 'zone')

const wrong = await asProgram.analyze({ file: 'page.tree', text: DOCUMENT })

// Without the role the same text goes through the code mill, which produces something else entirely. The
// incremental path reports undefined names per DEFINITION, and a document declares none, so it reports nothing
// and hands back a program that is not a component. That silence is exactly why the role has to reach here.
ok(
  'the same text without the role is not read as a document',
  !(wrong.program?.length === 1 && wrong.program[0]?.form === 'zone'),
  JSON.stringify(wrong.program?.map(one => one.form)),
)

const broken = await asDoc.analyze({ file: 'page.tree', text: 'view page\n  task main\n' })

ok(
  'a fault reaches the editor with the message a save gives',
  broken.diagnostics.some(d => /cannot declare a function/.test(d.message)),
  broken.diagnostics.map(d => d.message).join(' | '),
)

const withCatalog = new IncrementalAnalyzer(undefined, () => 'view', loaded.ok ? loaded.catalog : undefined)
const unregistered = await withCatalog.analyze({
  file: 'page.tree',
  text: 'view page\n  view text/nowhere\n    bind a, text <x>\n',
})

ok(
  'and the catalog reaches it too',
  unregistered.diagnostics.some(d => /not a component this document may place/.test(d.message)),
  unregistered.diagnostics.map(d => d.message).join(' | '),
)

console.log(`\nview-editor: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
