// A `make hash` local learns its key type from the keys written into it (term-self-host-001-0052, traps.md T038).
// Until 2026-10-29 a key read or written by index (`save seen/{w}, 1`, `seen/{w}`) was inferred and never held to the
// map's key, so a hash whose only writes were by index kept a free key, emitted `Map<number, number>` on TypeScript
// (which only tsc refused) and a map of integers natively. Now the index is the key: `Map<string, number>`, and the
// program runs on every backend.
// Run: npx tsx test/compile/hash-key-inferred.ts   (HASH_ONLY=typescript, rust, swift or kotlin runs one backend)

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

const PROGRAM = `load @term/base/list
  find list

task distinct
  take words, like list, like text
  like number
  save seen, make hash
  walk words
    take w
    save seen/{w}, 1
  save n, 0
  walk seen/keys()
    take k
    save n, add(n, seen/get(k))
  back n

task run
  like text
  send back, <{distinct(make(list, <a>, <b>, <a>, <c>))}>
`

const dir = mkdtempSync(join(tmpdir(), 'term-hash-key-'))
const only = process.env.HASH_ONLY ?? ''

{
  const built = compile(
    { file: join(dir, 'keys.tree'), text: PROGRAM },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  const ts = built.ok
    ? built.typescript
    : built.diagnostics.map(d => d.message).join(' | ')
  const declared = ts.match(/const seen: [^=]+=/)?.[0] ?? '(no seen)'

  ok(
    'typescript: the local is `Map<string, number>`, its key the text written',
    declared.includes('Map<string, number>'),
    declared,
  )

  const refused = compile(
    {
      file: join(dir, 'mixed.tree'),
      text: PROGRAM.replace(
        '    save seen/{w}, 1\n',
        '    save seen/{w}, 1\n    save three, 3\n    save seen/{three}, 1\n',
      ),
    },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )

  ok(
    'a number key written into the same hash is refused as a map key',
    !refused.ok &&
      refused.diagnostics.some(d => d.message.includes('map key')),
    refused.ok
      ? 'it built'
      : refused.diagnostics.map(d => d.message).join(' | '),
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
    `${backend}: three distinct words counted through a hash keyed by text`,
    ran.form === 'ran' && ran.output === '3',
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nhash-key-inferred: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
