// A case name two modules' forms share is built as the form its own file defines or imports. `make number` in
// compile/node.tree built compile/surface.tree's `primitive` case once both were in one program, although node.tree
// imports nothing from it: a field-less case fits every owner, so the checker left the construction's type open and
// the form merged last won (found porting compile/surface, 2026-10-05). check/scope.ts `bindSharedCases` tells each
// construction its owner. Run from deck/term/deck/term: npx tsx test/check/shared-case.ts
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { projectResolver } from '@term/call/code/make'

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
  const resolve = (path: string): Source | undefined =>
    files[path] !== undefined ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! } : undefined

  return compile({ file: 'main.tree', text: main }, { resolve })
}

const said = (result: ReturnType<typeof build>): string =>
  result.ok ? result.typescript : result.diagnostics.map(d => d.message).join(' | ')

// two modules, each with a form whose case is `number`, each building its own
const KINDS = `form kind\n  mark tag, name tag\n  case number\n  case text\n\ntask number-kind\n  like kind\n  send back, make number\n`
const WORDS = `form word\n  mark text\n  case number\n  case none\n\ntask number-word\n  like word\n  send back, make number\n`

{
  // main loads both and uses each module's task: each builds its own module's case
  const main = `load @app/kinds\n  find kind\n  find number-kind\n\nload @app/words\n  find word\n  find number-word\n\ntask run\n  like kind\n  send back\n    call number-kind\n`
  const result = build({ '@app/kinds': KINDS, '@app/words': WORDS }, main)
  ok('each module builds its own case of a shared name', result.ok, said(result))
}

{
  // the same with the modules merged in the other order
  const main = `load @app/words\n  find word\n  find number-word\n\nload @app/kinds\n  find kind\n  find number-kind\n\ntask run\n  like word\n  send back\n    call number-word\n`
  const result = build({ '@app/kinds': KINDS, '@app/words': WORDS }, main)
  ok('in either order', result.ok, said(result))
}

{
  // the shape that found it: the ENTRY file defines one owner (surface.tree's `primitive`) and an imported module builds
  // the other's case inside its own task (node.tree's `number-type`)
  const main = `${WORDS}\nload @app/kinds\n  find kind\n  find number-kind\n\ntask run\n  like kind\n  send back\n    call number-kind\n`
  const result = build({ '@app/kinds': KINDS }, main)
  ok('an imported module builds its own case when the entry defines another of the name', result.ok, said(result))
}

{
  // THE CASE THAT FOUND IT, held as it is: compile/surface.tree defines `primitive` with a case `number`, and loads
  // compile/node.tree, whose `number-type` builds its own `type`'s `number`. Smaller programs of the same shape
  // built without the fix, so the real module is compiled here, as the port build compiles it
  // absolute, so its relative loads (`./node`) resolve beside it
  const file = resolvePath('deck/make/code/compile/surface.tree')
  const result = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: projectResolver(resolvePath('deck/make'), 'node'), library: true, leanOf: () => true } as never)
  ok('compile/surface.tree builds beside node.tree, each building its own case', result.ok, said(result as ReturnType<typeof build>))
}

{
  // a construction in main itself, which imports ONE of the forms: it is that form's case
  const main = `load @app/kinds\n  find kind\n\nload @app/words\n  find number-word\n\ntask run\n  like kind\n  send back, make number\n`
  const result = build({ '@app/kinds': KINDS, '@app/words': WORDS }, main)
  ok('a file building a shared case gets the form it imported', result.ok, said(result))
}

console.log(`\nshared-case: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
