// The two hash READ shapes item 0054 left (term-self-host-001-0426): a plain segment read on a hash (`m/alpha`) reads
// the key "alpha", as the plain segment written (`save m/alpha, 3`) writes it since 0054, and an index read on a hash
// (`m/{k}`) reads the key `k`, as `m/get(k)` does. Until 2026-10-29 the first was a property read on TypeScript (no
// map read ever found it) and named no member natively, and the second emitted a list read: TypeScript stopped,
// rustc could not index a TermMap. A call on the hash (`m/get(k)`, `m/has(k)`) stays the method.
// Run: npx tsx test/compile/hash-read-shapes.ts   (HASH_ONLY=typescript, rust, swift or kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
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
    name: 'segment',
    says: 'a plain segment read on a hash reads that key',
    want: '3:4',
    program: `load @term/base/list
  find list

task counted
  take m, like hash, like text, like number
  like text
  back <{m/alpha}:{m/beta}>

task run
  like text
  save m, make hash
  save m/alpha, 3
  m/set(<beta>, 4)
  back counted(m)
`,
  },
  {
    name: 'index',
    says: 'an index read on a hash reads the key the index holds',
    want: '5:6:true',
    program: `load @term/base/list
  find list

task looked
  take m, like hash, like text, like number
  take k, like text
  like number
  back m/{k}

task run
  like text
  save m, make hash
  save k, <beta>
  save m/{k}, 5
  m/set(<gamma>, 6)
  back <{looked(m, k)}:{looked(m, <gamma>)}:{m/has(k)}>
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'term-hash-read-'))
const only = process.env.HASH_ONLY ?? ''

for (const one of CASES) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({
      backend,
      program: one.program,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: `hash-${one.name}`,
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${backend}: ${one.says}`,
      ran.form === 'ran' && ran.output === one.want,
      ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 600)}`,
    )
  }
}

console.log(`\nhash-read-shapes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
