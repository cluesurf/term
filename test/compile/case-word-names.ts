// A union's case may be named by a word the language also uses: `case fuse` and `case void` (term-self-host-001-0050,
// traps.md T038). Until 2026-10-29 both compiled wrong with no message:
//   - `case fuse` lost its name to the template pass, which read the bare word as a fuse of no template and dropped it,
//     so the case took the next node's word (`link`) and a match's `case fuse` arm took its first statement's
//   - `make void` of a union with a `case void` emitted the void value (`undefined`, Rust's boxed unit, Swift's `()`,
//     Kotlin's `Unit`) where the case was meant
// Each is held by running one program on every backend.
// Run: npx tsx test/compile/case-word-names.ts   (CASE_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

const PROGRAM = `form value
  case void
  case fuse
    link name, like text
  case word
    link name, like text

task blank
  like value
  back make void

task graft
  take name, like text
  like value
  save made
    make fuse
      bind name, name
  back made

task tell
  take v, like value
  like text
  sift v
    case void
      back <void>
    case fuse
      back <fuse {name}>
    case word
      back <word {name}>

task run
  like text
  save w
    make word
      bind name, <w>
  send back, <{tell(blank())} {tell(graft(<g>))} {tell(w)}>
`

// `case void` alone, so the emitters' half is held apart from the template pass's
const VOID_ONLY = `form value
  case void
  case word
    link name, like text

task blank
  like value
  back make void

task tell
  take v, like value
  like text
  sift v
    case void
      back <void>
    case word
      back <word {name}>

task run
  like text
  save w
    make word
      bind name, <w>
  send back, <{tell(blank())} {tell(w)}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-case-word-'))
const only = process.env.CASE_ONLY ?? ''

// the checker's view: the union has the three cases by their written names
{
  const built = compile(
    { file: join(dir, 'cases.tree'), text: PROGRAM },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  const form = built.ok
    ? built.program.find(
        s => s.form === 'record-type' && s.name === 'value',
      )
    : undefined
  const names =
    form && form.form === 'record-type'
      ? form.variants.map(v => v.name).join(' ')
      : ''

  ok(
    'the union builds',
    built.ok,
    built.ok ? '' : built.diagnostics.map(d => d.message).join(' | '),
  )
  ok(
    'its cases are void, fuse and word, and `fuse` keeps its name and its field',
    names === 'void fuse word',
    names,
  )
}

// the TypeScript of `blank` itself: a run may fold `tell(blank())` at compile time and never call it
{
  const built = compile(
    { file: join(dir, 'void.tree'), text: VOID_ONLY },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  const ts = built.ok ? built.typescript : ''
  const at = ts.indexOf('export function blank(')
  const body =
    at < 0 ? '(no blank)' : ts.slice(at, ts.indexOf('\n}\n', at) + 2)

  ok(
    'typescript: `blank` returns the case, not `undefined`',
    /return __termVariantVoid/.test(body) &&
      !/return undefined/.test(body),
    body,
  )
}

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const voided = runOn({
    backend,
    program: VOID_ONLY,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'void-case',
  })

  if (voided.form === 'skipped') {
    console.log(`skip  ${backend}: ${voided.reason}`)
    continue
  }

  ok(
    `${backend}: \`make void\` of a union with a \`case void\` builds the case, not the void value`,
    voided.form === 'ran' && voided.output === 'void word w',
    voided.form === 'ran'
      ? `got ${JSON.stringify(voided.output)}`
      : `${voided.stage}: ${voided.reason}`,
  )

  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'cases',
  })

  ok(
    `${backend}: \`make void\` builds the case, \`make fuse\` builds its case with its field, and each arm matches its own`,
    ran.form === 'ran' && ran.output === 'void fuse g word w',
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\ncase-word-names: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
