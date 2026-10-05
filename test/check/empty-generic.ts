// An empty list in a generic task: `head t / like list, like t / back make list`. The kernel typed an empty list's
// element as a fresh meta made knowing no binder, so it could never be solved to the task's own `t`, and the task was
// refused as `kernel: type mismatch: expected (Array t), found (Array ?0)`. Found by the engine/data/array port
// (self-hosting, 2026-10-04). check/elaborate.ts now lowers the element type the surface checker inferred, and where
// the checker left it open (a `host` binding is generalized) uses a CONTEXTUAL meta applied to the enclosing generics,
// which pattern unification can solve to `t`. The `host` + union case failed with the first half alone. Each program
// is built AND run. Run: npx tsx test/check/empty-generic.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

async function run(name: string, text: string, check: (mod: Record<string, (...a: unknown[]) => unknown>) => boolean): Promise<void> {
  const built = compile({ file: `/gate/code/${name}.tree`, text })

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-empty-generic-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>
  ok(name, check(mod))
}

// the smallest case: a generic task answering an empty list
await run(
  'a generic task returns an empty list',
  `task no-items
  head t
  like list
    like t
  send back
    make list

task count-none
  like number
  save none, call no-items
  send back, read none/length
`,
  mod => mod.countNone!() === 0,
)

// an empty list stored in a generic record, then grown: the shape the array port needs
await run(
  'an empty list inside a generic record, then pushed to',
  `form bag
  head t
  link items
    like list
      like t

task empty-bag
  head t
  like bag t
  save none
    make list
  send back
    make bag
      bind items, read none

task filled
  like number
  save b, call empty-bag
  save xs, read b/items
  call xs/push, code 7
  send back, read xs/length
`,
  mod => mod.filled!() === 1,
)

// the same empty list bound with `host` (a constant) first, the spelling `term lint --fix` gives it (L004)
await run(
  'an empty list bound with host, then stored in a generic record',
  `form bag
  head t
  link items
    like list
      like t

task empty-bag
  head t
  like bag t
  host none, make list
  send back
    make bag
      bind items, read none

task count-empty
  like number
  save b, call empty-bag
  send back, read b/items/length
`,
  mod => mod.countEmpty!() === 0,
)

// a generic UNION case holding the empty list, written straight in and bound with `host` first: the two spellings of
// engine/data/array's `empty`
for (const [label, body] of [
  ['an empty list straight into a generic union case', '  send back\n    make leaf\n      bind items, make list\n'],
  ['an empty list bound with host, then into a generic union case', '  host none, make list\n  send back\n    make leaf\n      bind items, read none\n'],
]) {
  await run(
    label!,
    `form tree
  head t
  case leaf
    link items
      like list
        like t
  case node
    link left, like tree t

task empty-tree
  head t
  like tree t
${body}
task leaf-count
  like number
  save e, call empty-tree
  send back, code 1
`,
    mod => mod.leafCount!() === 1,
  )
}

// a fresh list that a generic value is PUSHED into, and never read back by type: its element is the generic form.
// The push pinned the element only for a ground value, and a value of `pile t` did not count (`t` is a variable inside
// the task), so the element fell through to `number` and engine/data/array's `to-array` emitted `const stack: number[]`
// holding vectors: a tsc error, which only the TYPE shows. Held by the emitted annotation (2026-10-04)
{
  const text = `form pile
  head t
  case leaf
    link items, like list, like t
  case branch
    link left, like pile t

task count-piles
  head t
  take v, like pile t
  like number
  save stack
    make list
  call stack/push
    read v
  send back, read stack/length
`
  const built = compile({ file: '/gate/code/push-generic.tree', text })
  const declared = built.ok ? (/const stack: ([^=]+) =/.exec(built.typescript)?.[1] ?? '').trim() : 'failed'
  ok('a generic value pushed into a fresh list types its element', declared === 'Pile<T>[]', declared)
}

// a non-generic empty list still builds, typed by its declared element
await run(
  'a non-generic empty list is unchanged',
  `task names
  like list
    like text
  send back
    make list

task size
  like number
  save n, call names
  send back, read n/length
`,
  mod => mod.size!() === 0,
)

console.log(`\nempty-generic: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
