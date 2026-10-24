// A guard's caught binder is a local of its task, as a task's `take` is (term-compiler-0073). `halt take` / `take
// refused` in deck/deck/code/package/linking.tree read `refused` while three other files defined a task `refused`, and
// check/disambiguate.tree counted the binder as a reference to those tasks: line/base.tree was refused as
// duplicate-definition ('"refused" is defined in 3 files ... imports it from none of them').
// Run: npx tsx test/compile/guard-binder-local.ts

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

function said(result: ReturnType<typeof build>): string {
  return result.ok ? result.typescript : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')
}

// a guard whose caught binder is named `binder`, read as a value in its handler
function guarded(task: string, binder: string, answer: string): string {
  return `task ${task}
  like text
  fork
    mark unsafe
    halt <bad>
  halt take
    take ${binder}
    save seen, read ${binder}
    send back, text <${answer}>
  send back, text <ok>
`
}

// a top-level task named `name`, in its own file
function defines(name: string, answer: string): string {
  return `task ${name}\n  take x, like text\n  like text\n  send back, text <${answer}>\n\ntask other-${answer}\n  like text\n  send back, text <o>\n`
}

{
  // two files define a task `refused`, a third reads its guard binder `refused`, and the program holds all three
  const main = `load @app/a\n  find other-a\n\nload @app/b\n  find other-b\n\nload @app/g\n  find run-guarded\n\ntask run\n  like text\n  send back, call run-guarded\n`
  const result = build(
    { '@app/a': defines('refused', 'a'), '@app/b': defines('refused', 'b'), '@app/g': guarded('run-guarded', 'refused', 'g') },
    main,
  )
  ok('a guard binder named like a task two files define builds', result.ok, said(result))
  ok(
    'it is no duplicate-definition',
    !(!result.ok && result.diagnostics.some(d => d.name === 'duplicate-definition')),
    said(result),
  )
}

{
  // one other file defines `refused`: the binder must not be bound to that file's task either
  const main = `load @app/a\n  find other-a\n\nload @app/g\n  find run-guarded\n\ntask run\n  like text\n  send back, call run-guarded\n`
  const result = build({ '@app/a': defines('refused', 'a'), '@app/g': guarded('run-guarded', 'refused', 'g') }, main)
  ok('a guard binder named like one other file\'s task builds', result.ok, said(result))
  ok(
    'and the handler reads the caught value, not the task',
    result.ok && !/refused__in|refusedIn\d/.test(result.typescript),
    said(result),
  )
}

{
  // two modules each with a guard binding the same take name, a third loading both
  const main = `load @app/g1\n  find first\n\nload @app/g2\n  find second\n\ntask run\n  like text\n  send back, call first\n`
  const result = build({ '@app/g1': guarded('first', 'problem', 'one'), '@app/g2': guarded('second', 'problem', 'two') }, main)
  ok('two modules guarding with one binder name, loaded by a third, build', result.ok, said(result))
}

{
  // and both at once: each guarding module also defines a task of the binder's name
  const g1 = `${guarded('first', 'problem', 'one')}\n${defines('problem', 'p1')}`
  const g2 = `${guarded('second', 'problem', 'two')}\n${defines('problem', 'p2')}`
  const main = `load @app/g1\n  find first\n\nload @app/g2\n  find second\n\ntask run\n  like text\n  send back, call first\n`
  const result = build({ '@app/g1': g1, '@app/g2': g2 }, main)
  ok('guard binders named like a task their own files define build', result.ok, said(result))
  // the split renames each file's `problem` task apart, so a handler bound to its file's task reads a renamed name
  ok('and each handler reads its caught value, not its own file\'s task', result.ok && !/problem__in|problemIn\d/.test(result.typescript.replace(/function problem\w*\([^]*?\n}/g, '')), said(result))
}

console.log(`\nguard-binder-local: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
