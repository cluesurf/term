// A NATIVE MEMBER CALL HOLDS ITS ARGUMENT TO THE SLOT, whatever either type is yet. `xs/push(x)`, `xs/set(i, x)`,
// `m/set(k, v)` and the key of `m/get`, `m/has`, `m/delete` unified their argument with the slot only when the slot was
// still free and the argument's type was ground, on the belief that this path had no occurs check (the substitution's
// `bind-variable` has one). Two holes followed: text pushed into a list of numbers built, and a slot met by a value
// whose type was still open stayed free, so a native backend spelled it as the boxed unknown. A list pushed into
// itself is named as that, not as an opaque mismatch. guides/architecture/types/inference, "What is missing"
// (decisions-2026-10.md, D10, 2026-10-05).
// Run: sh tmp/run-term-ts.sh test/check/member-pin.ts

import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

function build(text: string, env: 'rust' | 'node', entryPoints: string[]) {
  return compile(
    { file: 'main.tree', text },
    { resolve: withNativeEnv(env, stdlibResolver()!), env, entryPoints },
  )
}

const said = (built: ReturnType<typeof build>): string =>
  built.ok ? '' : built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')

// text pushed into a list of numbers
{
  const built = build(
    `load @term/base/list
  find list

task fill
  take xs, like list, like number
  call xs/push, text <seven>
`,
    'node',
    ['fill'],
  )

  ok(
    'text pushed into a list of numbers is refused',
    !built.ok && built.diagnostics.some(d => d.name === 'type-mismatch' && /argument/.test(d.message)),
    said(built) || 'it built',
  )
}

// a hash key of the wrong type
{
  const built = build(
    `load @term/base/hash
  find hash

task look
  take table, like hash, like text, like number
  like boolean
  send back, call table/has, code 3
`,
    'node',
    ['look'],
  )

  ok(
    'a number looked up in a hash keyed by text is refused',
    !built.ok && built.diagnostics.some(d => d.name === 'type-mismatch'),
    said(built) || 'it built',
  )
}

// the right types still build
{
  const built = build(
    `load @term/base/list
  find list

load @term/base/hash
  find hash

task fill
  take xs, like list, like number
  take table, like hash, like text, like number
  call xs/push, code 7
  call xs/set, code(0), code 8
  call table/set, text(<a>), code 1
`,
    'node',
    ['fill'],
  )

  ok('the right element and key types build', built.ok, said(built))
}

// a list pushed into itself
{
  const built = build(
    `load @term/base/list
  find list

task loop
  save xs, make list
  call xs/push, read xs
`,
    'node',
    ['loop'],
  )

  ok(
    'a list pushed into itself is named as a type with no end',
    !built.ok && built.diagnostics.some(d => /"xs" would hold a value of its own type/.test(d.message)),
    said(built) || 'it built',
  )
}

// a value whose type is still OPEN when it is pushed: `x` is a parameter with no `like`, decided only by the caller.
// The element of `out` was left free, and Rust spelled `out` as a list of the boxed unknown
{
  const text = `load @term/base/list
  find list

task gather
  take x
  like list, like number
  save out, make list
  call out/push, read x
  send back, read out

task run
  like number
  save got, call gather, code 4
  send back, read got/length
`

  const node = build(text, 'node', ['run'])
  ok('a value of an open type pins the element (TypeScript)', node.ok, said(node))

  if (node.ok) {
    const ts = emitTypeScript(node.program)
    const line = ts.split('\n').filter(l => /\bout\b/.test(l)).join(' | ')
    ok('the list is a list of numbers on TypeScript', /out: number\[\]|out = \[\] as number\[\]|Array<number>/.test(ts) || !/any/.test(line), line)
  }

  const rust = build(text, 'rust', ['run'])
  ok('a value of an open type pins the element (Rust)', rust.ok, said(rust))

  if (rust.ok) {
    const emitted = emitRust(rust.program)
    ok('the list is not a list of the boxed unknown on Rust', !/dyn std::any::Any/.test(emitted), emitted.split('\n').filter(l => /out/.test(l)).join(' | '))
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
