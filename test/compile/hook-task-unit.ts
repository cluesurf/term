// A console built AS UNITS (`term boot`, the separate build) reaches the task its hook names by the name the task's
// module exports. Since term-compiler-0034 the import binding binds a hook's `task bank` like a call, so where the name
// is split by file the route carries the split name (`bank__in0_0`). A unit's module exports its written name (`bank`),
// so the bundle kept nothing under the route's name, shook the task out, and the command failed at run time with
// `task "bank__in0_0" is not exported by the program` (zone's `code save`, deck/zone/test/e2e.sh, term-compiler-0064).
// The zone shape: the task `bank` in one file, a form `bank` in another that a third file imports.
//
// Run: npx tsx test/compile/hook-task-unit.ts

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compileSeparate } from '@term/make/code/compile/separate'
import { CompileCache } from '@term/make/code/compile/cache'
import { projectResolver } from '@term/call/code/make'
import { commandRoutes } from '@term/call/code/work/hook/parsing'
import type { DockRoute, Program } from '@term/make/code/types'

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

const root = mkdtempSync(join(tmpdir(), 'hook-task-unit-'))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(
  join(root, 'deck.tree'),
  `deck @probe/hooks\n  mark <0.0.1>\n`,
)

const files: Record<string, string> = {
  // the form `bank`, and a file that imports it
  'kind.tree': `form bank\n  link name, like text\n`,
  'save.tree': `load ./kind\n  find bank\n\ntask keep\n  take all, like list, like bank\n  like number\n  back all/length\n`,
  // the task `bank`, and an ordinary one beside it
  'work.tree': `task bank\n  take sort, like text\n  like text\n  back <saved {sort}>\n\ntask tell\n  take sort, like text\n  like text\n  back <told {sort}>\n`,
  'base.tree': `load ./work\n  find bank\n  find tell\n\nload ./save\n  find keep\n\nhook code\n  hook save\n    slot sort\n      like text\n    task bank\n  hook show\n    slot sort\n      like text\n    task tell\n`,
}

for (const [name, text] of Object.entries(files)) {
  writeFileSync(join(root, 'code', name), text)
}

const entry = join(root, 'code', 'base.tree')
const result = compileSeparate(
  { file: entry, text: files['base.tree']! },
  {
    resolve: projectResolver(root),
    cache: new CompileCache(),
    modules: f => `./${f}`,
  },
)

ok(
  'the console builds as units',
  result.ok,
  result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '),
)

if (result.ok) {
  const names = (routes: DockRoute[]): string[] =>
    routes.flatMap(route => [
      ...route.calls.map(call => call.name),
      ...names(route.children),
    ])
  const routed = names(commandRoutes(result.docks as Program))
  const exported = new Set(
    result.exports.filter(one => !one.type).map(one => one.exported),
  )

  ok(
    'the routes name both tasks',
    routed.length === 2,
    routed.join(' '),
  )
  ok(
    '`code save` names the task as its unit exports it',
    routed.includes('bank'),
    routed.join(' '),
  )
  ok(
    '`code show` names its task',
    routed.includes('tell'),
    routed.join(' '),
  )
  ok(
    'every task a route names is exported by the units',
    routed.every(name => exported.has(name)),
    routed.filter(name => !exported.has(name)).join(' '),
  )
  ok(
    '`bank` is exported from the file that defines the task',
    result.exports.some(
      one =>
        !one.type &&
        one.exported === 'bank' &&
        one.file.endsWith('/code/work.tree'),
    ),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
