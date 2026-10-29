// A task a console hook names (`hook build` / `task make`) is reached like a call: bound by what the console's file
// imported and kept by the shake. The route carried the name as text and the import binding never saw it, so where
// the name is split by file (two modules define `make`, renamed `make__in<g>_<k>`) the hook reached neither, both were
// left out of the program, and the command found no task at run time, while the build was clean (term-compiler-0034,
// the four wrapper tasks of deck/call/code/line/base.tree). The console is built whole and its command run through the
// dispatcher `term boot` runs a console with (call/code/boot-plan.tree `cli-run-text`).
//
// Run: npx tsx test/compile/hook-task-reach.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { commandRoutes } from '@term/call/code/work/hook/parsing'
import {
  runCommandLine,
  toCamel,
} from '@term/call/code/work/hook/running'

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

// `make` the verb, and another module's `make` of another type, so the name is split by file
const VERB = `task make\n  take name, like text\n  like text\n  send back, text <made {name}>\n`
const OTHER = `task make\n  take n, like number\n  like number\n  send back, code 2\n\ntask other\n  like number\n  send back\n    call make\n      code 1\n`
const CONSOLE = `load @app/verb\n  find make\n\nload @app/other\n  find other\n\nhook build\n  take name\n    like text\n  task make\n\ntask run\n  like number\n  send back, call other\n`

const files: Record<string, string> = {
  '@app/verb': VERB,
  '@app/other': OTHER,
}
const resolve = (path: string): Source | undefined =>
  files[path] !== undefined
    ? { file: `${path.slice('@app/'.length)}.tree`, text: files[path]! }
    : undefined
const result = compile(
  { file: 'console.tree', text: CONSOLE },
  {
    resolve,
    roleOf: file => (file === 'console.tree' ? 'call' : undefined),
  },
)
const said = result.ok
  ? result.typescript
  : result.diagnostics.map(d => d.message).join(' | ')
ok('a console whose hook names a split task compiles', result.ok, said)

if (result.ok) {
  const routes = commandRoutes(result.program)
  const named = routes.flatMap(route =>
    route.calls.map(call => call.name),
  )
  ok('the hook names one task', named.length === 1, named.join(', '))

  const task = named[0] ?? ''
  ok(
    'the task the hook names is in the program',
    result.program.some(
      statement =>
        statement.form === 'function' && statement.name === task,
    ),
    `${task} | ${said}`,
  )

  const dir = mkdtempSync(join(tmpdir(), 'term-hook-reach-'))
  const file = join(dir, 'app.mjs')
  writeFileSync(
    file,
    transformSync(result.typescript, { loader: 'ts', format: 'esm' })
      .code,
  )
  const app = (await import(pathToFileURL(file).href)) as Record<
    string,
    unknown
  >
  ok(
    'the emitted module exports it under the name the dispatcher asks for',
    typeof app[toCamel(task)] === 'function',
    `${toCamel(task)} | ${Object.keys(app).join(', ')}`,
  )

  const out: string[] = []
  const code = await runCommandLine({
    name: 'console',
    routes,
    argv: ['build', '--name', 'x'],
    resolve: name => app[toCamel(name)] as never,
    out: line => out.push(line),
    err: line => out.push(line),
  })
  ok(
    'the command runs the imported task',
    code === 0,
    `${code} ${out.join(' / ')}`,
  )
  ok(
    "the other module's make is still its own",
    (app.run as () => number)?.() === 2,
    String((app.run as () => number)?.()),
  )
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
