// A plain segment WRITTEN on a hash is a literal key (term-self-host-001-0054, traps.md T007), as `xs/0` is a literal
// index on a list: `save st/needs/exception, true` writes the key "exception". Until 2026-10-29 TypeScript set a
// PROPERTY of the map object (`st.needs.exception = true`), so `has` and `get` never found the key, the native
// backends named a member no map has, and a key of another type was taken in silence. Now it is the key on every
// backend, held to the map's key type. A key is read with `get`: a plain segment READ on a hash is still a property read (log.md, item 0054).
// Run: npx tsx test/compile/hash-literal-key.ts   (KEY_ONLY=typescript, rust, swift or kotlin runs one backend)

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

const PROGRAM = `form state
  link needs, like hash, like text, like boolean

task run
  like text
  save st
    make state
      bind needs, make hash
  save st/needs/exception, true
  save found, st/needs/has(<exception>)
  save read, st/needs/get(<exception>)
  save counts, make hash
  save key, <alpha>
  save counts/{key}, 1
  save counts/alpha, add(counts/get(<alpha>), 2)
  send back, <{found} {read} {st/needs/size} {counts/get(<alpha>)} {counts/size}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-hash-literal-'))
const only = process.env.KEY_ONLY ?? ''

{
  const built = compile(
    { file: join(dir, 'keys.tree'), text: PROGRAM },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  const ts = built.ok
    ? built.typescript
    : built.diagnostics.map(d => d.message).join(' | ')

  ok(
    'typescript: the write is a `.set` of the key',
    /needs\.set\("exception", true\)/.test(ts),
    ts.slice(ts.indexOf('export function run')),
  )
  ok(
    'typescript: and never a property of the map',
    !/needs\.exception\b/.test(ts),
    ts.slice(ts.indexOf('export function run')),
  )

  const numbered = compile(
    {
      file: join(dir, 'numbered.tree'),
      text: 'task run\n  like number\n  save m, make hash\n  save three, 3\n  save m/{three}, 1\n  save m/alpha, 2\n  back m/size\n',
    },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )

  ok(
    'a word key on a hash keyed by numbers is refused as a map key',
    !numbered.ok &&
      numbered.diagnostics.some(d => d.message.includes('map key')),
    numbered.ok
      ? 'it built'
      : numbered.diagnostics.map(d => d.message).join(' | '),
  )
}

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: 'keys',
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: a key written by a plain segment is found by has and get, and counted`,
    ran.form === 'ran' && ran.output === 'true true 1 3 1',
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nhash-literal-key: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
