// A raise written `halt <text>` raises `failure` even where nothing loads @term/base/exception, so the build holds no
// `failure` form (item term-self-host-001-0315). Until then the raise was invisible there: a caller's `halt failure`
// bound was refused as "nothing it calls raises failure", and a handler's `case failure` compiled to
// `problem === "failure"` (never true) with its locals unbound, and no diagnostic.
// Run: npx tsx test/check/text-raise-failure.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

const LEAN = { leanOf: () => true, library: true }

const REFUSE = `task refuse
  take note, like text

  halt <{note}>
`

// the caller declares what its callee raises
const BOUND = `${REFUSE}
task run
  take note, like text
  like number
  halt failure

  refuse(note)
  back 1
`

// a bound the body does not reach is still refused
const WIDE = `task run
  take note, like text
  like number
  halt failure

  back 1
`

// a handler over the caught value, one arm renaming the first shared field, one selecting `note`
const CAUGHT = `${REFUSE}
task run
  take note, like text
  like text

  fork
    mark unsafe
    refuse(note)
  halt take
    take problem
    sift problem
      case failure
        link said
        back said
  back <none>

task told
  take note, like text
  like text

  fork
    mark unsafe
    refuse(note)
  halt take
    take problem
    sift problem
      case failure
        link note
        back <caught {note}>
  back <none>
`

// an arm naming what the guarded body cannot raise
const STRAY = `${REFUSE}
form absence
  link thing, like text

task run
  take note, like text
  like text

  fork
    mark unsafe
    refuse(note)
  halt take
    take problem
    sift problem
      case failure
        back <failure>
      case absence
        back <absence>
  back <none>
`

const messages = (result: ReturnType<typeof compile>): string =>
  (result.diagnostics ?? [])
    .filter(d => d.severity !== 'warning')
    .map(d => `${d.name}: ${d.message}`)
    .join(' | ')

async function main(): Promise<void> {
  const bound = compile({ file: 'bound.tree', text: BOUND }, LEAN)
  ok(
    "a caller may declare halt failure for a callee's text raise",
    bound.ok,
    messages(bound),
  )

  const wide = compile({ file: 'wide.tree', text: WIDE }, LEAN)
  ok(
    'a halt failure bound nothing reaches is still refused',
    !wide.ok &&
      wide.diagnostics.some(
        d =>
          d.name === 'raise-bound' &&
          d.message.includes('nothing it calls raises "failure"'),
      ),
    wide.ok ? 'compiled' : messages(wide),
  )

  const caught = compile({ file: 'caught.tree', text: CAUGHT }, LEAN)
  ok(
    'a handler sifting a text raise compiles',
    caught.ok,
    messages(caught),
  )

  const ts = caught.ok ? caught.typescript : ''
  ok(
    'the arm tests what was raised',
    ts.includes('problem.form === "failure"'),
    ts.match(/if \(problem[^)]*\)/)?.[0] ?? '',
  )
  ok(
    'the arm never compares the caught value with text',
    !ts.includes('problem === "failure"'),
  )
  ok(
    'the renaming arm binds its local',
    /const said = problem\.\w+/.test(ts),
  )

  if (caught.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-text-raise-'))
    const file = join(dir, 'caught.mjs')
    writeFileSync(
      file,
      transformSync(caught.typescript, { loader: 'ts', format: 'esm' })
        .code,
    )
    const mod = await import(pathToFileURL(file).href)
    ok(
      'the raise reaches the arm and its field binds',
      mod.told('boom') === 'caught boom',
      String(mod.told('boom')),
    )
    ok(
      'the renaming arm returns a text, never undefined',
      typeof mod.run('boom') === 'string',
      String(mod.run('boom')),
    )
  }

  const stray = compile({ file: 'stray.tree', text: STRAY }, LEAN)
  ok(
    'an arm the guarded body cannot raise is refused',
    !stray.ok &&
      stray.diagnostics.some(d =>
        d.message.includes(
          '"absence" is not something the guarded body can raise',
        ),
      ),
    stray.ok ? 'compiled' : messages(stray),
  )

  console.log(`\ntext-raise-failure: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
