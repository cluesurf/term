// Two modules defining one name (native-dom-0031). Names are package-global, so a call bound in silence to whichever
// definition was merged last: `run` below imports `pick` from a, and before this it compiled to b's, inlined to "b".
// Now each call binds by its own file's import, and a call whose file imports the name from neither definer, or from
// both, is refused naming the files. What must still compile: an abstract signature overridden by its implementation
// (the env chain), an arity overload, and a parameter-type overload.
// Run: npx tsx test/compile/ambiguous-name.ts

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

const PICK_A = `task pick\n  take x, like text\n  like text\n  send back, text <a>\n`
const PICK_B = `task pick\n  take x, like text\n  like text\n  send back, text <b>\n`
// c uses b's pick inside, so b's pick arrives in a program that imports only c's own task
const C = `load @app/b\n  find pick\n\ntask helper\n  like text\n  send back\n    call pick\n      text <y>\n`

const MAIN = `load @app/a
  find pick

load @app/c
  find helper

task run
  like text
  send back
    call pick
      text <x>

task run-helper
  like text
  send back, call helper
`

{
  // each call binds by its own file's import: main imported a's pick, c imported b's
  const result = build({ '@app/a': PICK_A, '@app/b': PICK_B, '@app/c': C }, MAIN)
  const text = result.ok ? result.typescript : result.diagnostics.map(d => d.message).join(' | ')
  ok('two bodied definitions in two files compile when each caller imported one', result.ok, text)
  const body = (name: string) => (result.ok ? (new RegExp(`function ${name}\\(\\)[^}]*}`).exec(result.typescript)?.[0] ?? '') : '')
  // each file's definitions are renamed `pick__in<group>_<file index>`, files in sorted order: a.tree is 0, b.tree is 1
  ok("main's call reaches a's pick, the one main imported", /"a"/.test(body('run')) || /pickIn\d+_0\(/.test(body('run')), body('run'))
  // `helper` may be inlined into `run-helper`, so the answer is read from whichever of the two holds it
  const helped = `${body('helper')} ${body('runHelper')}`
  ok("c's call reaches b's pick, the one c imported", /"b"/.test(helped) || /pickIn\d+_1\(/.test(helped), helped)
}

{
  // main calls pick but imports it from neither definer: refused, naming both files
  const main = `load @app/c\n  find helper\n\nload @app/a\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n`
  const a = `${PICK_A}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': a, '@app/b': PICK_B, '@app/c': C }, main)
  const message = result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
  ok('a call whose file imports the name from neither is refused', !result.ok, result.ok ? result.typescript : '')
  ok('the refusal names both files', message.includes('a.tree') && message.includes('b.tree'), message)
  ok('it is a duplicate-definition', !result.ok && result.diagnostics.some(d => d.name === 'duplicate-definition'), message)
}

{
  // a and b define pick over text, d over numbers; main imports d's, which is not one of the two, and reaches it
  const d = `task pick\n  take x, like number\n  like text\n  send back, text <d>\n`
  const main = `load @app/d\n  find pick\n\nload @app/c\n  find helper\n\nload @app/a\n  find other\n\ntask run\n  like text\n  send back\n    call pick\n      code 3\n\ntask run-helper\n  like text\n  send back, call helper\n`
  const a = `${PICK_A}\ntask other\n  like text\n  send back, text <o>\n`
  const result = build({ '@app/a': a, '@app/b': PICK_B, '@app/c': C, '@app/d': d }, main)
  ok(
    'a call importing a third definition of the name, typed apart, is left to it',
    result.ok && /"d"/.test(result.typescript),
    result.ok ? result.typescript : result.diagnostics.map(x => x.message).join(' | '),
  )
}

{
  // main imports pick from both definers: refused
  const main = `load @app/a\n  find pick\n\nload @app/b\n  find pick\n\ntask run\n  like text\n  send back\n    call pick\n      text <x>\n`
  const result = build({ '@app/a': PICK_A, '@app/b': PICK_B }, main)
  const message = result.ok ? '' : result.diagnostics.map(d => d.message).join(' | ')
  ok('a call whose file imports the name from both is refused', !result.ok && /more than one/.test(message), message)
}

{
  // an abstract declaration with no body, and its implementation: the implementation wins, as the env chain needs
  const abstract = `task pick\n  take x, like text\n  like text\n`
  const result = build(
    { '@app/a': PICK_A, '@app/b': abstract, '@app/c': C },
    MAIN,
  )
  ok('a signature with no body is still overridden', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))
}

{
  // arity tells them apart
  const two = `task pick\n  take x, like text\n  take y, like text\n  like text\n  send back, text <b>\n`
  const c = `load @app/b\n  find pick\n\ntask helper\n  like text\n  send back\n    call pick\n      text <y>\n      text <z>\n`
  const result = build({ '@app/a': PICK_A, '@app/b': two, '@app/c': c }, MAIN)
  ok('an arity overload across files compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))
  ok('and each call reaches its own', result.ok && /"a"/.test(result.typescript) && /"b"/.test(result.typescript), result.ok ? result.typescript : '')
}

{
  // the parameter type tells them apart
  const numeric = `task pick\n  take x, like number\n  like text\n  send back, text <b>\n`
  const c = `load @app/b\n  find pick\n\ntask helper\n  like text\n  send back\n    call pick\n      code 3\n`
  const result = build({ '@app/a': PICK_A, '@app/b': numeric, '@app/c': c }, MAIN)
  ok('a parameter-type overload across files compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))
}

{
  // native-dom-0036: a form's method calling a sibling by bare name, while another module has a top-level task of that
  // name at another arity. The top-level one used to take the call, refused as one argument too many inside box.tree
  const box = `form box
  link items, like list
    like text

  task drop
    take self
    take key, like text
    like boolean
    send back, true

  task empty
    take self
    like box
    walk list, read self/items
      hook next
        take site, name key
        call drop
          read self
          read key
    send back, read self
`
  const dom = `task drop\n  take node, like number\n  like void\n  save skip, code 0\n`
  const main = `load @app/box\n  find box\n  find empty\n\nload @app/dom\n  find drop\n\ntask run\n  like number\n  save b\n    make box\n      bind items\n        make list\n  call empty\n    read b\n  call drop\n    code 3\n  send back, code 1\n`
  const result = build({ '@app/box': box, '@app/dom': dom }, main)
  ok(
    "a method's bare call to a sibling reaches the sibling, not a top-level task of the name",
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '),
  )
}

{
  // a LOCAL of the name shadows every definition: `maybe/filter` calls its own callback parameter `test`, while the
  // stdlib's file module and the CLI's app-verbs each define a top-level `test`. The call names no import, so asking
  // which import it came from refused it, and broke @term/call's build (2026-10-02)
  const keep = `task keep\n  take test, like task\n    take x, like text\n    like boolean\n  take x, like text\n  like boolean\n  send back\n    call test\n      read x\n`
  // main brings BOTH definers into the program (a for `other`, b for `test` itself), so the name is ambiguous
  // program-wide and only the parameter in keep.tree is not
  const main = `load @app/keep\n  find keep\n\nload @app/a\n  find other\n\nload @app/b\n  find test\n\ntask run\n  like boolean\n  send back\n    call keep\n      task\n        take x, like text\n        like boolean\n        send back, true\n      text <x>\n`
  const testA = `task test\n  take x, like text\n  like boolean\n  send back, true\n\ntask other\n  like text\n  send back, text <o>\n`
  const testB = `task test\n  take x, like text\n  like boolean\n  send back, false\n`
  const result = build({ '@app/keep': keep, '@app/a': testA, '@app/b': testB }, main)
  ok(
    'a call to a parameter that shares a name two files define is the parameter',
    !(!result.ok && result.diagnostics.some(d => d.name === 'duplicate-definition')),
    result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '),
  )
}

{
  // a LEAN nested call to a name two files define, under a call to that same name: the import binding renames every
  // `pick` apart before the resolver runs, so the nested one has to be a call by then or it is a label naming nothing
  // (`"pick__from0_0" has no parameter "pick"`, deck/site/code/http/http.tree, 2026-10-02)
  const files: Record<string, string> = { '@app/a': PICK_A, '@app/b': PICK_B, '@app/c': C }
  const resolve = (p: string): Source | undefined =>
    files[p] !== undefined ? { file: `${p.slice('@app/'.length)}.tree`, text: files[p]! } : undefined
  const main = `load @app/a\n  find pick\n\nload @app/c\n  find helper\n\ntask run\n  like text\n  back pick(pick(<x>))\n`
  const result = compile({ file: 'main.tree', text: main }, { resolve, leanOf: file => file === 'main.tree' })
  ok(
    'a lean nested call to an ambiguous name is bound like any other call',
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '),
  )
}

console.log(`\nambiguous-name: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
