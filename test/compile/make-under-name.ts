// A construction's value written UNDER its name: `make some(x)`, and `make some x`, which parses the same, since a space
// nests as a parenthesis does. The grammar reads a construction's values beside the name (`make some, x`), so these
// were dropped without a word: `make some(error)` built `{ form: "some", value: undefined }` on TypeScript (the stdlib's
// generic `maybe`), and a local one-field case reached the kernel as an unapplied constructor. Found by the time/compare
// port (self-hosting, 2026-10-04); compile/mint-bridge.ts `recordOf` reads them as positional values. Each program is
// built AND run, in a lean file and in longhand. Run: npx tsx test/compile/make-under-name.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

async function run(
  name: string,
  text: string,
  lean: boolean,
  check: (mod: Record<string, (...a: unknown[]) => unknown>) => boolean,
): Promise<void> {
  const built = compile({ file: `/gate/code/${name.replace(/\W+/g, '-')}.tree`, text }, { leanOf: () => lean })

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-make-under-name-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>
  ok(name, check(mod), JSON.stringify(Object.keys(mod)))
}

const FORMS = `form reading
  case some
    link value, like number
  case none

form pair
  slot left, like number
  slot right, like number
`

const unwrap = (value: unknown): unknown => (value as { value?: unknown }).value

for (const [label, body] of [
  ['make some(x)', 'back make some(x)'],
  ['make some x', 'back make some x'],
  ['make some(add(x, 1))', 'back make some(add(x, 1))'],
]) {
  await run(
    `lean: ${label}`,
    `${FORMS}\ntask wrap\n  take x, like number\n  like reading\n  ${body}\n`,
    true,
    mod => unwrap(mod.wrap!(41)) === (label!.includes('add') ? 42 : 41),
  )
}

// two values under the name fill a form's slots in order, as two beside it do
await run(
  'lean: make pair(x, y) fills the slots',
  `${FORMS}\ntask both\n  take x, like number\n  take y, like number\n  like pair\n  back make pair(x, y)\n`,
  true,
  mod => JSON.stringify(mod.both!(1, 2)) === '{"left":1,"right":2}',
)

// the native list, written with its items under the name: it built an EMPTY list (note/term/plan/
// silent-defects-third-batch.md, which deck/call/test/item/parity.tree wrote around)
await run(
  'lean: make list(80, 40) holds both items',
  `task widths\n  like list, like number\n  back make list(80, 40)\n`,
  true,
  mod => JSON.stringify(mod.widths!()) === '[80,40]',
)

await run(
  'lean: make list(<a>, <b>) holds both texts',
  `task names\n  like list, like text\n  back make list(<a>, <b>)\n`,
  true,
  mod => JSON.stringify(mod.names!()) === '["a","b"]',
)

await run(
  'lean: make some(80), a literal under the name',
  `${FORMS}\ntask eighty\n  like reading\n  back make some(80)\n`,
  true,
  mod => unwrap(mod.eighty!()) === 80,
)

// longhand: `make some x` under a call was dropped the same way
await run(
  'longhand: make some x',
  `${FORMS}\ntask wrap\n  take x, like number\n  like reading\n  send back, make some x\n`,
  false,
  mod => unwrap(mod.wrap!(7)) === 7,
)

// the stdlib's generic `maybe`, imported, where the value was dropped in SILENCE rather than refused
{
  const text = `load @term/base/maybe\n  find maybe\n\ntask wrap\n  take x, like number\n  like maybe number\n  back make some(x)\n`
  const built = compile({ file: '/gate/code/generic-maybe.tree', text }, { leanOf: () => true, resolve: projectResolver(process.cwd(), 'node') })
  const body = built.ok ? (/function wrap[^]*?\n}/.exec(built.typescript)?.[0] ?? '') : built.diagnostics.map(d => d.message).join(' | ')
  ok('lean: the imported maybe keeps its value', /value: x\b/.test(body) && !/undefined as any/.test(body), body)
}

console.log(`\nmake-under-name: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
