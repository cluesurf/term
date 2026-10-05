// A form's TAG read as a field (`s/form`, or `s/kind` under `mark tag, name kind`): the case's name as text, on every
// backend. The checker marks the member read with `tag` (check/infer.ts, `unionTags`); TypeScript reads the field its
// values carry, and Rust, Swift and Kotlin call the accessor each gives the form (`term_tag`, `termTag`, compile/tag.ts).
// Before, every backend refused the read: `"shape" has no field "form"`.
// Run: npx tsx test/compile/tag-native.ts   (TAG_ONLY=typescript, rust, swift or kotlin runs one)

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

type Case = { name: string; says: string; want: string; program: string }

const CASES: Case[] = [
  {
    name: 'form',
    says: '`s/form` is the case name as written, a case with fields and one without',
    want: 'circle big-dot',
    program: `form shape
  case circle
    link radius, like number
  case big-dot

task name-of
  take s, like shape
  like text
  back s/form

task run
  like text
  save a, make(circle, bind(radius, 2))
  save b, make big-dot
  send back, <{name-of(a)} {name-of(b)}>
`,
  },
  {
    name: 'kind',
    says: 'under `mark tag, name kind` the tag is read as `s/kind`',
    want: 'circle big-dot',
    program: `form shape
  mark tag, name kind
  case circle
    link radius, like number
  case big-dot

task run
  like text
  save a, make(circle, bind(radius, 2))
  save b, make big-dot
  send back, <{a/kind} {b/kind}>
`,
  },
  {
    name: 'generic',
    says: 'a generic form, one case holding the type argument',
    want: 'full empty',
    program: `form slot
  head t
  case full
    link value, like t
  case empty

task tag-of
  take s, like slot, like number
  like text
  back s/form

task run
  like text
  save a, make(full, bind(value, 3))
  save b, make empty
  send back, <{tag-of(a)} {tag-of(b)}>
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-tag-native-'))
const only = process.env.TAG_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({ backend, program: one.program, resolve: env => projectResolver(process.cwd(), env), dir, name: one.name })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says} (${one.name})`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
    )
  }
}

// a write to the tag is refused: it would make a circle say it is a big-dot while still holding a radius. It built on
// TypeScript (`a.form = "big-dot"`) before the refusal
if (!only || only === 'typescript') {
  const written = compile(
    {
      file: join(dir, 'write.tree'),
      text: `form shape\n  case circle\n    link radius, like number\n  case big-dot\n\ntask run\n  like text\n  save a, make(circle, bind(radius, 2))\n  save a/form, <big-dot>\n  back a/form\n`,
    },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  ok('a write to the tag is refused, naming the form', !written.ok && written.diagnostics.some(d => d.message.includes('is the tag of "shape"')), written.ok ? 'built' : written.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\ntag-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
