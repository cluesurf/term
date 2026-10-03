// A LABELLED CALL TO A FORM METHOD THAT A TOP-LEVEL TASK SHADOWS. `call get / bind self, read xs / bind index,
// code 0` was checked against a top-level `get`'s parameters whenever any module in the program defined one (the
// stdlib's http client did, as `get(url, header)`), and refused as `type-mismatch` or as a name the task does not
// take, while the positional `call get / read xs / code 0` dispatched on its first argument and compiled. Six such
// calls in @term/site were rewritten positionally to get around it (note/plan/term-surf-guides.md). Now a call whose
// labels include `self`, or that the top-level task's parameters cannot take and a method's can, binds to the method
// of its receiver's form (check/infer.ts, bindLabelledMethod).
// Run: npx tsx test/compile/method-label.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'

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

function build(files: Record<string, string>, main: string) {
  const resolve = (p: string): Source | undefined =>
    files[p] !== undefined ? { file: `${p.slice('@app/'.length)}.tree`, text: files[p]! } : undefined

  return compile({ file: 'main.tree', text: main }, { resolve })
}

const show = (result: ReturnType<typeof build>): string =>
  result.ok ? result.typescript : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')

// a form with a `get` method, and a module with a top-level `get` of the same arity and other parameters
const BOX = `form box
  link items, like list
    like text

  task get
    take self
    take index, like number
    like text
    send back, text <from-box>
`

const NET = `task get
  take url, like text
  take header, like text
  like text
  send back, text <from-net>
`

const LOADS = `load @app/box\n  find box\n\nload @app/net\n  find get\n\n`

const make = `  save b\n    make box\n      bind items\n        make list\n`

{
  // the control: positional dispatch on the first argument already worked
  const main = `${LOADS}task run\n  like text\n${make}  send back\n    call get\n      read b\n      code 0\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('positional: a method call dispatches on its receiver', result.ok && /from-box|box_get|boxGet/.test(result.typescript), show(result))
}

{
  // the gap: the same call with its arguments labelled
  const main = `${LOADS}task run\n  like text\n${make}  send back\n    call get\n      bind self, read b\n      bind index, code 0\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('labelled `bind self`: binds to the method, not the top-level task', result.ok, show(result))
  ok('and the emitted call is the method', result.ok && !/\bget\(b, 0\)/.test(result.typescript) && /box/i.test(result.typescript), show(result))
}

{
  // labels written out of order are put in the method's order
  const main = `${LOADS}task run\n  like text\n${make}  send back\n    call get\n      bind index, code 0\n      bind self, read b\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('labels out of order: placed by the method\'s parameters', result.ok, show(result))
  // `index` is `like number`, so placed in written order (`b` as the index) this would be a type-mismatch
  ok('and it is the method, receiver first', result.ok && /from-box/.test(result.typescript), show(result))
}

{
  // the top-level task called with ITS labels still reaches the top-level task
  const main = `${LOADS}task run\n  like text\n  send back\n    call get\n      bind url, text <u>\n      bind header, text <h>\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('the top-level task with its own labels is still the top-level task', result.ok && !/box_get|boxGet/i.test(result.typescript.split('function run')[1] ?? ''), show(result))
}

{
  // a label neither has is still refused, naming the task
  const main = `${LOADS}task run\n  like text\n${make}  send back\n    call get\n      bind self, read b\n      bind nothing, code 0\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('a label the method lacks is still refused', !result.ok, show(result))
}

{
  // a receiver whose form has no such method is not rewritten: the call falls to the top-level task and is refused
  const main = `${LOADS}task run\n  like text\n  send back\n    call get\n      bind self, text <t>\n      bind index, code 0\n`
  const result = build({ '@app/box': BOX, '@app/net': NET }, main)
  ok('a `self` whose type owns no such method is not bound to an unrelated method', !result.ok, show(result))
}

{
  // `find get` of a METHOD name, with a top-level `get` elsewhere in the program: the importing file's labelled call
  // still reaches the method
  const main = `load @app/box\n  find box\n  find get\n\nload @app/other\n  find other\n\ntask run\n  like text\n${make}  send back\n    call get\n      bind self, read b\n      bind index, code 0\n`
  const other = `load @app/net\n  find get\n\ntask other\n  like text\n  send back\n    call get\n      text <u>\n      text <h>\n`
  const result = build({ '@app/box': BOX, '@app/net': NET, '@app/other': other }, main)
  ok('`find get` of a method name, top-level get loaded elsewhere: the labelled call is the method', result.ok, show(result))
}

// A MEMBER CALL ONTO A FORM'S OWN METHOD: `call b/bump / code 2` where `bump` takes `self` first. It was typed as the
// whole method and called with `b` as a JavaScript `this`, refused one argument short; passing `b` by hand compiled to
// `b.bump(b, 2)` on a plain record (bindMemberMethod)
const COUNTER = `form counter
  link count, like number

  task bump
    take self, like counter
    take by, like number
    like number
    send back
      call add
        read self/count
        read by

  task reset
    take self, like counter
    like number
    send back, code 0
`

{
  const main = `load @app/counter\n  find counter\n\ntask run\n  like number\n  save c\n    make counter\n      bind count, code 1\n  send back\n    call c/bump\n      code 2\n`
  const result = build({ '@app/counter': COUNTER }, main)
  ok('`call c/bump / code 2` on a form calls the method with c as self', result.ok, show(result))
  ok('and it is not emitted as a member call on the record', result.ok && !/c\.bump\(/.test(result.typescript), show(result))
}

{
  const main = `load @app/counter\n  find counter\n\ntask run\n  like number\n  save c\n    make counter\n      bind count, code 1\n  send back, call c/reset\n`
  const result = build({ '@app/counter': COUNTER }, main)
  ok('a member call with no arguments passes the receiver alone', result.ok && !/c\.reset\(/.test(result.typescript), show(result))
}

{
  // a labelled member call places by the method's parameters, receiver first
  const main = `load @app/counter\n  find counter\n\ntask run\n  like number\n  save c\n    make counter\n      bind count, code 1\n  send back\n    call c/bump\n      bind by, code 2\n`
  const result = build({ '@app/counter': COUNTER }, main)
  ok('a labelled member call onto a method', result.ok, show(result))
}

{
  // the wrong argument count on a member method call is still refused, now against the method less `self`
  const main = `load @app/counter\n  find counter\n\ntask run\n  like number\n  save c\n    make counter\n      bind count, code 1\n  send back, call c/bump\n`
  const result = build({ '@app/counter': COUNTER }, main)
  ok('a member method call missing an argument is refused', !result.ok, show(result))
}

{
  // a field still reads as a field
  const main = `load @app/counter\n  find counter\n\ntask run\n  like number\n  save c\n    make counter\n      bind count, code 1\n  send back, read c/count\n`
  const result = build({ '@app/counter': COUNTER }, main)
  ok('a field read is untouched', result.ok, show(result))
}

console.log(`\nmethod-label: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
