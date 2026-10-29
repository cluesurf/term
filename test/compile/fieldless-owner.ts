// Two forms that each declare a field-less case of one name get a constant and guard each, keyed by their form and
// case, each built with the tag field its own form declares (decision 061 of
// note/project/term/self-host/change/001-finish-self-host, trap T-0360). Until then the TypeScript emitter wrote one
// constant per case NAME, so `make blank` of `piece` built `{kind: "blank"}`, the tag of the other form. A case only
// one form declares keeps its plain name, so no other program's text moves. Emitted AND run.
// Run: npx tsx test/compile/fieldless-owner.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { BACKENDS, runOn } from './shared/run-on'

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

const text = `form inspect
  mark tag, name kind
  case text
  case blank

form piece
  case blank
  case lone
  case chain
    link parts, like list, like text

task first
  like inspect
  send back, make blank

task second
  like piece
  send back, make blank

task third
  like piece
  send back, make lone

task inspect-name
  take i, like inspect
  like text
  fork case, read i
    case text
      send back, text <text>
    case blank
      send back, text <inspect blank>

task piece-name
  take p, like piece
  like text
  fork case, read p
    case blank
      send back, text <piece blank>
    case lone
      send back, text <lone>
    case chain
      send back, text <chain>
`

const out = compile({ file: '/gate/code/fieldless-owner.tree', text })
ok(
  'it compiles',
  out.ok,
  out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '),
)
const ts = out.ok ? out.typescript : ''
const lines = ts
  .split('\n')
  .filter(
    line =>
      /__termVariant|__termIs/.test(line) &&
      /const|function/.test(line),
  )

ok(
  'the shared case has one constant per form, tagged as its form declares',
  /const __termVariantInspectBlank = Object\.freeze\(\{ kind: "blank" as const \}\)/.test(
    ts,
  ) &&
    /const __termVariantPieceBlank = Object\.freeze\(\{ form: "blank" as const \}\)/.test(
      ts,
    ),
  lines.join('\n'),
)
ok(
  'no constant is named by the shared case alone',
  !/__termVariantBlank\b/.test(ts),
  lines.join('\n'),
)
ok(
  'a case one form declares keeps its plain name',
  /const __termVariantLone = Object\.freeze\(\{ form: "lone" as const \}\)/.test(
    ts,
  ),
  lines.join('\n'),
)

if (out.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-fieldless-owner-'))
  const file = join(dir, 'fieldless-owner.ts')
  writeFileSync(file, ts)
  const m = (await import(pathToFileURL(file).href)) as Record<
    string,
    (...args: unknown[]) => unknown
  >

  ok(
    'inspect blank carries kind',
    JSON.stringify(m.first!()) === '{"kind":"blank"}',
    JSON.stringify(m.first!()),
  )
  ok(
    'piece blank carries form',
    JSON.stringify(m.second!()) === '{"form":"blank"}',
    JSON.stringify(m.second!()),
  )
  ok('the two are different values', m.first!() !== m.second!())
  ok(
    'each match finds its own blank',
    m.inspectName!(m.first!()) === 'inspect blank' &&
      m.pieceName!(m.second!()) === 'piece blank',
    `${String(m.inspectName!(m.first!()))} / ${String(m.pieceName!(m.second!()))}`,
  )
  ok(
    'the other cases still match',
    m.pieceName!(m.third!()) === 'lone' &&
      m.pieceName!({ form: 'chain', parts: [] }) === 'chain',
  )
}

// every backend: each form's blank is its own value and each match finds it. The native backends emit one enum per
// form, so a case name is scoped by its form there already; this holds them to the same answer
const NATIVE = `form inspect
  mark tag, name kind
  case text
  case blank

form piece
  case blank
  case lone

task inspect-name
  take i, like inspect
  like text
  sift i
    case text
      back <text>
    case blank
      back <inspect-blank>

task piece-name
  take p, like piece
  like text
  sift p
    case blank
      back <piece-blank>
    case lone
      back <lone>

task first
  like inspect
  back make blank

task second
  like piece
  back make blank

task third
  like piece
  back make lone

task run
  like text
  save i, first()
  save p, second()
  save q, third()
  back <{inspect-name(i)} {piece-name(p)} {piece-name(q)} {i/kind} {p/form}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-fieldless-owner-native-'))
const only = process.env.FIELDLESS_ONLY ?? ''
for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: NATIVE,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'fieldless-owner',
  })
  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }
  ok(
    `${backend}: each form's blank is its own, and each match finds it`,
    ran.form === 'ran' &&
      ran.output === 'inspect-blank piece-blank lone blank blank',
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nfieldless-owner: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
