// Every rebuild explained (note/term/plan/incremental-best-in-class.md, step 6, `term make --explain`). A unit that is
// built says why: its own text, a name it reaches and which, its settings, the compiler, or nothing recorded. The
// reasons are compile/explain.tree comparing the inputs a unit was last built from with the ones it has now.
// Run: npx tsx test/compile/explain.ts

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { UnitExplain } from '@term/make/code/compile/separate'
import type { UnitInputs } from '@term/make/code/compile/explain'
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

const root = mkdtempSync(join(tmpdir(), 'explain-'))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/explain\n  mark <0.0.1>\n`)

const helper = join(root, 'code', 'helper.tree')
const entry = join(root, 'code', 'base.tree')
const entryText = `load ./helper\n  find greet\n\ntask main\n  like text\n  back greet(<you>)\n`
writeFileSync(entry, entryText)

// the records, kept the way the CLI keeps them, across builds
const kept = new Map<string, UnitInputs>()

const build = (helperText: string, cache: CompileCache) => {
  writeFileSync(helper, helperText)

  const explain: UnitExplain = { reasons: new Map(), recall: id => kept.get(id), remember: (id, inputs) => kept.set(id, inputs) }
  const result = compileSeparate({ file: entry, text: entryText }, { resolve: projectResolver(root), cache, modules: f => `./${f}`, explain })
  const reasonsOf = (name: string): string[] => [...explain.reasons].find(([label]) => label.endsWith(`/code/${name}.tree`))?.[1] ?? []

  return { ok: result.ok, helper: reasonsOf('helper'), entry: reasonsOf('base'), built: explain.reasons.size }
}

const greet = (params: string): string => `task greet\n${params}  like text\n  save said, <hello>\n  back said\n`
const cache = new CompileCache(undefined, 'one')

const first = build(greet('  take who, like text\n'), cache)
ok('the first build builds', first.ok)
ok('a unit never built before says so', first.helper.some(reason => reason.startsWith('nothing recorded')), first.helper.join(' | '))

const body = build(`task greet\n  take who, like text\n  like text\n  save said, <hello there>\n  back said\n`, cache)
ok('a body edit builds', body.ok)
ok('the edited unit names its own text', body.helper.some(reason => reason.startsWith('its own text changed') && reason.endsWith('helper.tree')), body.helper.join(' | '))
ok('and its importer is not built at all', body.entry.length === 0, body.entry.join(' | '))

const signature = build(greet('  take who, like text\n  take how, like text, fall <!>\n'), cache)
ok('a signature edit builds', signature.ok)
ok('the importer names the name that changed', signature.entry.includes('`greet` changed'), signature.entry.join(' | '))
ok('and nothing else', signature.entry.length === 1, signature.entry.join(' | '))

const compiler = build(greet('  take who, like text\n  take how, like text, fall <!>\n'), new CompileCache(undefined, 'two'))
ok('a new compiler builds', compiler.ok)
ok('and every unit says the compiler changed', compiler.helper.includes('the compiler changed') && compiler.entry.includes('the compiler changed'), `${compiler.helper.join(' | ')} / ${compiler.entry.join(' | ')}`)

const again = build(greet('  take who, like text\n  take how, like text, fall <!>\n'), new CompileCache(undefined, 'two'))
ok('a fresh cache with nothing changed says the stored answer was missing', again.helper.includes('its stored answer was missing'), again.helper.join(' | '))

console.log(`\nexplain: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
