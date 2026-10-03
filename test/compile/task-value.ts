// A task named where its RESULT was meant. Three holes, all compiling clean and all found porting compile/view-cap
// (2026-10-02):
//   - `f()` parsed exactly as `f`, so `save b, make-box()` saved the task itself
//   - a member read off a task (`read make-box/size`) typed as unknown and emitted `makeBox.size`
//   - a `fall` default was never checked against its parameter, so `fall text <four>` on a number emitted
//     `n: number = "four"`, and `fall read make-box` passed the task
// Run: npx tsx test/compile/task-value.ts

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

const BOX = `form box
  link size, like number

task make-box
  like box
  send back
    make box
      bind size, 4
`

function build(text: string, lean = false): { ok: boolean; ts: string; said: string } {
  const out = compile({ file: '/gate/code/task-value.tree', text }, lean ? { leanOf: () => true } : {})

  return {
    ok: out.ok,
    ts: out.ok ? out.typescript : '',
    said: out.ok ? '' : out.diagnostics.map(d => d.message).join(' | '),
  }
}

// the empty parentheses are a call
{
  const lean = build(`${BOX}
task use
  like number
  save b, make-box()
  back b/size
`, true)
  ok('lean `f()` is a call', lean.ok && !/makeBox\.size/.test(lean.ts), lean.said || lean.ts.slice(lean.ts.indexOf('function use')))

  const fall = build(`${BOX}
task use
  take b, like box, fall make-box()
  like number
  back b/size
`, true)
  ok('lean `fall f()` is a call', fall.ok && /b: Box = makeBox\(\)/.test(fall.ts), fall.said || fall.ts.slice(fall.ts.indexOf('function use')))

  const longhand = build(`${BOX}
task use
  like number
  save b, make-box()
  send back, read b/size
`)
  ok('longhand `f()` is a call too', longhand.ok && !/makeBox\.size/.test(longhand.ts), longhand.said || longhand.ts)
}

// a task has no fields
{
  const named = build(`${BOX}
task use
  like number
  send back, read make-box/size
`)
  ok('a member read off a task is refused', !named.ok && /"make-box" is a task, which has no field "size"/.test(named.said), named.said)

  const held = build(`${BOX}
task use
  like number
  save b, read make-box
  send back, read b/size
`)
  ok('a member read off a local holding a task is refused', !held.ok && /"b" holds a task/.test(held.said), held.said)

  const called = build(`${BOX}
task use
  like number
  save b, call make-box
  send back, read b/size
`)
  ok('a member read off the call is fine', called.ok, called.said)
}

// a default is a value of its parameter's type
{
  const text = build(`task use
  take n
    like number
    fall text <four>
  like number
  send back, read n
`)
  ok('a text default for a number is refused', !text.ok && /the default of "n": expected number, found string/.test(text.said), text.said)

  const task = build(`${BOX}
task use
  take b
    like box
    fall read make-box
  like number
  send back, read b/size
`)
  ok('a task default for a record is refused', !task.ok && /the default of "b": expected box/.test(task.said), task.said)

  const right = build(`${BOX}
task use
  take b
    like box
    fall call make-box
  take by, like number, fall 2
  like number
  send back
    call multiply
      read b/size
      read by
`)
  ok('a well-typed default compiles', right.ok, right.said)

  const generic = build(`task first-or
  head t
  take xs
    like list
      like t
  take fallback
    like t
    fall code 0
  like t
  send back, read fallback
`)
  ok('a default for a generic parameter is not pinned here', generic.ok, generic.said)
}

console.log(`\ntask-value: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
