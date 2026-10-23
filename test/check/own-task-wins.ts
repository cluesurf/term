// A FILE'S OWN TASK WINS over a method of a form another file defines (module-scope-0008). A file holding
// `task last` (returning 99) that loads `@term/base/list / find list` and calls `last(make list, 3, 1, 2)` bound the
// call to list's `last` method (`list_last`, a maybe), and the program printed `[object Object]` from a green build.
// The binding is decided once, in the checker (check/infer.ts receiver dispatch), so every backend emits the same call:
// this test reads the checked program, not one backend's text.
//
// Run: npx tsx test/check/own-task-wins.ts

import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'

const projectResolve = projectResolver(process.cwd(), 'node')

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

function build(main: string, files: Record<string, string> = {}) {
  const resolve = (path: string, from: string): Source | undefined =>
    files[path] !== undefined
      ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! }
      : projectResolve(path, from)

  return compile({ file: 'main.tree', text: main }, { resolve })
}

type Result = ReturnType<typeof build>

const said = (result: Result): string =>
  result.ok ? result.typescript.slice(0, 400) : result.diagnostics.map(d => d.message).join(' | ')

// every callee name the body of task `name` calls, from the checked program
function calleesOf(result: Result, name: string): string[] {
  if (!result.ok) {
    return []
  }

  const task = result.program.find(
    statement => statement.form === 'function' && statement.name === name,
  )
  const out: string[] = []
  const stack: unknown[] = [task]

  while (stack.length > 0) {
    const node = stack.pop()

    if (!node || typeof node !== 'object') {
      continue
    }

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as { form?: string; callee?: { form?: string; name?: string } }

    if (record.form === 'call' && record.callee?.form === 'variable' && record.callee.name) {
      out.push(record.callee.name)
    }

    for (const [key, value] of Object.entries(node)) {
      if (key !== 'span' && key !== 'type') {
        stack.push(value)
      }
    }
  }

  return out
}

const LOADS = `load @term/base/list\n  find list\n\n`

{
  // the reported case: the file's own `last` is the one called
  const main = `${LOADS}task last\n  take xs, like list, like number\n  like number\n  send back, code 99\n\ntask run\n  like number\n  send back, call last(make(list, 3, 1, 2))\n`
  const result = build(main)
  const callees = calleesOf(result, 'run')
  ok('a file\'s own task builds', result.ok, said(result))
  ok('a file\'s own task wins over list\'s method of the same name', callees.includes('last') && !callees.some(c => /^list_last/.test(c)), callees.join(','))
}

{
  // the same call with no task of the file's own still reaches list's method
  const main = `${LOADS}task run\n  send back, call last(make(list, 3, 1, 2))\n`
  const result = build(main)
  const callees = calleesOf(result, 'run')
  ok('without a task of its own, the call still dispatches to list\'s method', callees.some(c => /^list_last/.test(c)), `${callees.join(',')} ${said(result)}`)
}

{
  // a method of a form the SAME file defines still dispatches on its receiver: both are the file's own
  const main = `form box\n  link n, like number\n  task size\n    take self, like box\n    like number\n    send back, read self/n\n\ntask size\n  take x, like text\n  like number\n  send back, code 7\n\ntask run\n  like number\n  save b\n    make box\n      bind n, code 3\n  send back, call size(read b)\n`
  const result = build(main)
  const callees = calleesOf(result, 'run')
  // the method may be inlined to `b.n`, so what is held is that the same-named task is not the one called
  ok('a method of the file\'s own form still dispatches beside a same-named task', result.ok && !callees.includes('size'), `${callees.join(',')} ${said(result)}`)
}

{
  // a task of another file never takes the call from the method: only the CALLING file's own task wins
  const other = `task last\n  take xs, like list, like number\n  like number\n  send back, code 99\n\ntask other\n  like number\n  send back, code 1\n`
  const main = `${LOADS}load @app/other\n  find other\n\ntask run\n  send back, call last(make(list, 3, 1, 2))\n`
  const result = build(main, { '@app/other': other })
  const callees = calleesOf(result, 'run')
  ok('another file\'s task of the name does not take the call from the method', !callees.includes('last'), `${callees.join(',')} ${said(result)}`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
