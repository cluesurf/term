// `mark private` is enforced per file (check/private.ts). A task marked private is visible only inside the file
// that defines it: a call from another file, a reference to it as a value, and a `find` of it in a `load` are each
// refused as `private-name`, naming the file. Exact rather than name-based: a parameter or local of the same name in
// another file is its own binding and is never refused. A file under the package's `test/` may use a private task of
// that package. `note private` is the old spelling, still honored, and warned about as `note-private`.
// Run: npx tsx test/compile/private-name.ts

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

// `@app/<path>` resolves to `/pkg/<path>.tree`, so a file under `/pkg/test/` is a test of the package
function build(files: Record<string, string>, main: string, file = '/pkg/code/main.tree') {
  const resolve = (p: string): Source | undefined =>
    files[p] !== undefined ? { file: `/pkg/${p.slice('@app/'.length)}.tree`, text: files[p]! } : undefined

  return compile({ file, text: main }, { resolve })
}

const said = (result: ReturnType<typeof build>): string =>
  result.ok ? result.typescript : result.diagnostics.map(d => `${d.name}: ${d.message} (${d.hint ?? ''})`).join(' | ')

const refusedAsPrivate = (result: ReturnType<typeof build>): boolean =>
  !result.ok && result.diagnostics.some(d => d.name === 'private-name')

// a.tree: a private helper, and a public task that uses it
const A = `task helper
  mark private
  take x, like text
  like text
  send back, read x

task shout
  take x, like text
  like text
  send back
    call helper
      read x
`

{
  // the defining file uses its own private task
  const result = build({}, `${A}\ntask run\n  like text\n  send back\n    call helper\n      text <hi>\n`)
  ok('a private task called from its own file compiles', result.ok, said(result))
  ok('and emits no warning for `mark private`', result.ok && !result.warnings.some(w => w.name === 'note-private'), said(result))
}

{
  // another file calls a's private helper by its package-global name
  const main = `load @app/a\n  find shout\n\ntask run\n  like text\n  send back\n    call helper\n      text <hi>\n`
  const result = build({ '@app/a': A }, main)
  const message = said(result)
  ok('a private task called from another file is refused', refusedAsPrivate(result), message)
  ok('the refusal names the defining file', message.includes('in /pkg/a.tree'), message)
  ok('the hint says how to fix it', message.includes('remove `mark private` from helper in'), message)
  ok('the refusal points at the calling file', !result.ok && result.diagnostics[0]!.file === '/pkg/code/main.tree', message)
}

{
  // another file passes the private task as a value
  const main = `load @app/a\n  find shout\n\ntask run\n  like text\n  save f, read helper\n  send back, text <x>\n`
  const result = build({ '@app/a': A }, main)
  ok('a private task referenced as a value from another file is refused', refusedAsPrivate(result), said(result))
}

{
  // another file finds the private task in a load block
  const main = `load @app/a\n  find helper\n\ntask run\n  like text\n  send back, text <x>\n`
  const result = build({ '@app/a': A }, main)
  const message = said(result)
  ok('a `find` of a private task is refused', refusedAsPrivate(result), message)
  ok('the find refusal points at the `find` line', !result.ok && result.diagnostics[0]!.span.start.line === 1, message)
}

{
  // a parameter and a local in another file share the private task's name: each is its own binding
  const main = `load @app/a
  find shout

task run
  take helper, like text
  like text
  send back, read helper

task again
  like text
  save helper, text <local>
  send back, read helper

task loud
  like text
  send back
    call shout
      text <hi>
`
  const result = build({ '@app/a': A }, main)
  ok('a same-named parameter or local in another file is not refused', result.ok, said(result))
}

{
  // a public definition of the name the call may bind to keeps it reachable: a typed overload in b
  const b = `task helper\n  take x, like number\n  like text\n  send back, text <n>\n`
  const main = `load @app/a\n  find shout\n\nload @app/b\n  find helper\n\ntask run\n  like text\n  send back\n    call helper\n      code 3\n`
  const result = build({ '@app/a': A, '@app/b': b }, main)
  ok('a call that may bind to a public overload is not refused', result.ok, said(result))
}

{
  // a test of the package may use the package's private task
  const main = `load @app/code/a\n  find shout\n\ntask check-helper\n  like text\n  send back\n    call helper\n      text <hi>\n`
  const result = build({ '@app/code/a': A }, main, '/pkg/test/a.tree')
  ok("a file under the package's test/ may call its private task", result.ok, said(result))

  // the same file outside test/ may not
  const outside = build({ '@app/code/a': A }, main, '/pkg/code/check.tree')
  ok('the same call from outside test/ is refused', refusedAsPrivate(outside), said(outside))
}

{
  // `note private`: the old spelling, honored and warned about
  const old = A.replace('mark private', 'note private')
  const own = build({}, `${old}\ntask run\n  like text\n  send back\n    call helper\n      text <hi>\n`)
  ok('`note private` still compiles in its own file', own.ok, said(own))
  const warning = own.ok ? own.warnings.find(w => w.name === 'note-private') : undefined
  ok('`note private` warns as note-private', warning !== undefined && warning.severity === 'warning', said(own))
  ok('the warning says to write `mark private`', (warning?.hint ?? '').includes('`mark private`'), warning?.hint ?? '')

  const main = `load @app/a\n  find shout\n\ntask run\n  like text\n  send back\n    call helper\n      text <hi>\n`
  const result = build({ '@app/a': old }, main)
  ok('`note private` is still enforced across files', refusedAsPrivate(result), said(result))
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
