// A `dock load` alias and a task of one name in one file are two things, told apart by where the name stands
// (term/compiler decision 007): the root of a path reaches the dock module, a call or a bare value the task. On
// TypeScript the dock's local `const resolveModule: any = __dock_resolveModule` sat beside `function resolveModule`,
// and `resolve-module/basename(file)` read `.basename` off the TASK: undefined at run time, the build clean
// (term-compiler-0043, term-cli-in-term-0100). Each output is checked as text on every backend and run on TypeScript.
//
// Run: npx tsx test/compile/dock-alias-task.ts (from deck/term/deck/term)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'

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

const file = '/gate/code/alias.tree'
const text = `dock load
  load <node:path>, name resolve-module

task resolve-module
  take file, like text
  like text
  back resolve-module/basename(file)

task by-call
  like text
  back resolve-module(<a/b.txt>)

task by-value
  take pick
    like task
      take file, like text
      like text
  like text
  back pick(<a/b.txt>)

task as-value
  like text
  back by-value(resolve-module)
`

const built = compile({ file, text }, { leanOf: () => true })
const said = built.ok ? built.typescript : built.diagnostics.map(d => d.message).join(' | ')

ok('a dock alias named like a task of its file builds', built.ok, said)

if (built.ok) {
  const lines = built.typescript.split('\n').filter(l => /resolveModule|__dock/.test(l)).join(' / ')

  ok('the task keeps its name', /function resolveModule\(/.test(built.typescript), lines)
  ok('the dock is bound under a name the task cannot take', /const __dockAny_resolveModule: any = __dock_resolveModule/.test(built.typescript), lines)
  ok('no const of the task name', !/const resolveModule\b/.test(built.typescript), lines)
  ok('the path read is off the dock', /__dockAny_resolveModule\.basename\(file\)/.test(built.typescript), lines)

  const out = join(mkdtempSync(join(tmpdir(), 'term-dock-alias-')), 'module.mjs')
  let mod: Record<string, (...args: unknown[]) => unknown> = {}

  try {
    writeFileSync(out, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
    mod = (await import(pathToFileURL(out).href)) as typeof mod
    ok('the output loads', true)
  } catch (error) {
    ok('the output loads', false, String(error).split('\n')[0])
  }

  const run = (name: string, ...args: unknown[]): unknown => {
    try {
      return mod[name]?.(...args)
    } catch (error) {
      return (error as Error).message
    }
  }

  ok('the task reads the dock: resolve-module(<a/b.txt>) is b.txt', run('resolveModule', 'a/b.txt') === 'b.txt', String(run('resolveModule', 'a/b.txt')))
  ok('a call of the task answers b.txt', run('byCall') === 'b.txt', String(run('byCall')))
  ok('the task passed as a value answers b.txt', run('asValue') === 'b.txt', String(run('asValue')))
}

// no clash: the output is as before, the dock bound under its own name
{
  const plain = compile(
    { file, text: 'dock load\n  load <node:path>, name node-path\n\ntask base-of\n  take file, like text\n  like text\n  back node-path/basename(file)\n' },
    { leanOf: () => true },
  )

  ok('with no clash the dock keeps its own local', plain.ok && /const nodePath: any = __dock_nodePath/.test(plain.typescript) && /nodePath\.basename\(file\)/.test(plain.typescript), plain.ok ? '' : plain.diagnostics[0]?.message)
}

// the native backends: the path root is the dock's spelling, never the task's
for (const env of ['rust', 'swift', 'kotlin'] as const) {
  const result = compile({ file, text }, { leanOf: () => true, env })

  if (!result.ok) {
    ok(`${env} builds`, false, result.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const emitted = env === 'rust' ? emitRust(result.program) : env === 'swift' ? emitSwift(result.program) : emitKotlin(result.program)
  const reads = emitted.split('\n').filter(l => /basename/.test(l)).join(' / ')
  const want = env === 'rust' ? /\bresolve_module::basename\(/ : env === 'swift' ? /[^_]\bresolveModule\.basename\(/ : /[^:_]\bresolveModule\.basename\(/
  const wrong = env === 'rust' ? /resolve_module__task::/ : /resolveModule__task\.basename|::resolveModule__task/

  ok(`${env}: the path read is off the dock`, want.test(emitted) && !wrong.test(emitted), reads)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail > 0 ? 1 : 0)
