// In a lean file a call-shaped part under a call, `greet(name(<x>))`, whose head is a parameter of the callee AND names
// a task in scope, reads as a call and ran as the label: it answered `x` where the writer meant `named`
// (term-compiler-0044). It is refused as `label-or-call`, naming both readings (term/compiler decision 009). The label
// spelling `name <x>` and the call spelling `call name(<x>)` each mean one thing, and a call-shaped label whose head
// names nothing callable builds as before. Each output that builds is run.
//
// Run: npx tsx test/compile/lean-label-or-call.ts (from deck/term/deck/term)

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

const folder = mkdtempSync(join(tmpdir(), 'term-label-or-call-'))
let count = 0

const head = `task name
  take x, like text
  like text
  back <named>

task greet
  take name, like text
  like text
  back name
`

type Built = { ok: true; answer: unknown; typescript: string } | { ok: false; diagnostics: { name: string; message: string; severity: string }[] }

async function build(run: string): Promise<Built> {
  const result = compile({ file: '/gate/code/label.tree', text: `${head}\n${run}` }, { leanOf: () => true })

  if (!result.ok) {
    return { ok: false, diagnostics: result.diagnostics as never }
  }

  const file = join(folder, `out-${count++}.mjs`)
  writeFileSync(file, transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code)
  const module = await import(pathToFileURL(file).href)

  return { ok: true, answer: module.run(), typescript: result.typescript }
}

const said = (built: Built): string => (built.ok ? `built, answered ${JSON.stringify(built.answer)}` : built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))

// the call-shaped part naming both the parameter and the task
const both = await build(`task run
  like text
  back greet(name(<x>))
`)

ok('greet(name(<x>)) is refused', !both.ok, said(both))
ok('  as label-or-call, an error', !both.ok && both.diagnostics.some(d => d.name === 'label-or-call' && d.severity === 'error'), said(both))
ok(
  '  naming the argument, the task and both spellings',
  !both.ok &&
    both.diagnostics.some(
      d => d.message.includes('"name(<x>)" under "greet"') && d.message.includes('argument "name"') && d.message.includes('task "name"') && d.message.includes('name <x>') && d.message.includes('call name(<x>)'),
    ),
  said(both),
)

// the call, written so
const called = await build(`task run
  like text
  back greet(call name(<x>))
`)

ok('greet(call name(<x>)) answers named', called.ok && called.answer === 'named', said(called))

// the label, written so
const labeled = await build(`task run
  like text
  save said
    greet
      name <x>
  back said
`)

ok('greet / name <x> answers x with no diagnostic', labeled.ok && labeled.answer === 'x', said(labeled))

// a call-shaped label whose head names nothing callable is unchanged
{
  const result = compile(
    {
      file: '/gate/code/label.tree',
      text: `task greet
  take who, like text
  like text
  back who

task run
  like text
  back greet(who(<x>))
`,
    },
    { leanOf: () => true },
  )
  let answer: unknown

  if (result.ok) {
    const file = join(folder, `out-${count++}.mjs`)
    writeFileSync(file, transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code)
    answer = (await import(pathToFileURL(file).href)).run()
  }

  ok('greet(who(<x>)) with no task who answers x', result.ok && answer === 'x', result.ok ? JSON.stringify(answer) : result.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
