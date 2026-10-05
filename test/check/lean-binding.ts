// Four ways a name bound wrongly once a program held two modules that each worked alone, all found by the engine/value
// port (self-hosting, 2026-10-04), when engine/data/trit, float, string and array met in one program:
//
//   1. a lean call to a native BINDING, `twice(helper(1))`, where two files define `helper`: the label was nested only
//      by the resolver, after binding had renamed `helper` apart, so it named nothing (check/overload.ts nestLeanLabels)
//   2. the same inside a METHOD call, `b/add-to(helper(1))`
//   3. two forms naming a case alike (`leaf` on `vector` and `rope`): a match read the case of the form declared LAST,
//      so `case leaf / back length` bound the task `length` instead of the field (check/infer.ts `caseFields`,
//      check/resolve.ts)
//   4. a task beside a METHOD of its name in another module: `push` on the stdlib's `list`, and engine/data/array's
//      task `push`. A file importing the list's `push` was bound to the task (check/overload.ts, `elsewhere`)
//
// Each program is built and run. Run: npx tsx test/check/lean-binding.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { emitRust } from '@term/make/code/compile/rust'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'

const project = projectResolver(process.cwd(), 'node')

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

// a package of `@app/<name>` lean modules, the stdlib behind them, and a lean main
async function run(name: string, files: Record<string, string>, main: string, check: (mod: Record<string, (...a: unknown[]) => unknown>) => boolean): Promise<void> {
  const resolve = (path: string, ...rest: unknown[]): Source | undefined =>
    files[path] !== undefined
      ? { file: `/app/code/${path.slice('@app/'.length)}.tree`, text: files[path]! }
      : (project as (...a: unknown[]) => Source | undefined)(path, ...rest)
  const built = compile({ file: '/app/code/main.tree', text: main }, { resolve: resolve as never, leanOf: () => true })

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => d.message).join(' | '))

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-lean-binding-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>
  ok(name, check(mod))
}

const HELPER_A = 'task helper\n  take n, like number\n  like number\n  back add(n, 10)\n'
const HELPER_B = 'task helper\n  take n, like number\n  like number\n  back add(n, 100)\n\ntask other-b\n  like number\n  back helper(1)\n'
const TWICE = 'bind twice\n  take x, like number\n  like number\n  case node\n    text <($x * 2)>\n'

await run(
  'a lean call to a binding nests a task two files define',
  { '@app/a': HELPER_A, '@app/b': HELPER_B, '@app/twice': TWICE },
  'load @app/a\n  find helper\n\nload @app/b\n  find other-b\n\nload @app/twice\n  find twice\n\ntask run\n  like number\n  back twice(helper(1))\n',
  mod => mod.run!() === 22,
)

await run(
  'a lean METHOD call nests a task two files define',
  { '@app/a': HELPER_A, '@app/b': HELPER_B },
  'load @app/a\n  find helper\n\nload @app/b\n  find other-b\n\nform box\n  link n, like number\n\n  task add-to\n    take self\n    take more, like number\n    like number\n    back add(self/n, more)\n\ntask run\n  like number\n  save b\n    make box\n      bind n, 5\n  back b/add-to(helper(1))\n',
  mod => mod.run!() === 16,
)

// two forms with a case `leaf`, and a task named like the one case's field
const ROPE = 'form rope\n  case leaf\n    link text, like text\n    link length, like number\n  case branch\n    link left, like rope\n    link length, like number\n\ntask length\n  take r, like rope\n  like number\n  back measure(r)\n\ntask measure\n  take r, like rope\n  like number\n  sift r\n    case leaf\n      back length\n    case branch\n      back length\n\ntask make-rope\n  take written, like text\n  take count, like number\n  like rope\n  back\n    make leaf\n      bind text, written\n      bind length, count\n'
const VECTOR = 'form vector\n  case leaf\n    link items, like list, like number\n  case branch\n    link left, like vector\n    link size, like number\n\ntask size-of\n  take v, like vector\n  like number\n  sift v\n    case leaf\n      back items/length\n    case branch\n      back size\n'

await run(
  'a match reads its own form\'s case when another form names a case alike',
  { '@app/rope': ROPE, '@app/vector': VECTOR },
  'load @app/rope\n  find rope\n  find length, name rope-length\n\nload @app/vector\n  find vector\n  find size-of\n\ntask run\n  take r, like rope\n  like number\n  back rope-length(r)\n',
  mod => mod.run!({ form: 'leaf', text: 'abc', length: 3 }) === 3 && mod.run!({ form: 'branch', left: { form: 'leaf', text: 'a', length: 1 }, length: 9 }) === 9,
)

// a module's own task `push`, beside the stdlib list's METHOD `push`, which another module imports
const ARRAY = 'form vector\n  link items, like list, like number\n\ntask push\n  take v, like vector\n  take value, like number\n  like vector\n  save items, v/items\n  items/push(value)\n  back\n    make vector\n      bind items, items\n'

await run(
  'a file importing a method keeps it beside another file\'s task of its name',
  { '@app/array': ARRAY },
  'load @app/array\n  find vector\n\nload @term/base/list\n  find push\n\ntask run\n  like number\n  save out, make list\n  call push\n    bind list, read out\n    bind item, 7\n  back out/length\n',
  mod => mod.run!() === 1,
)

// two aliases of ONE imported name from two modules: each alias reaches the module its own find named (the scope's
// `aliases`). engine.tree's `float-to-number` and `decimal-to-number` both bound to the stdlib binding
const CONV_A = 'task conv\n  take n, like number\n  like number\n  back add(n, 1)\n'
const CONV_B = 'task conv\n  take n, like number\n  like number\n  back add(n, 100)\n'

await run(
  'two aliases of one name from two modules each reach their own',
  { '@app/a': CONV_A, '@app/b': CONV_B },
  'load @app/a\n  find conv, name a-conv\n\nload @app/b\n  find conv, name b-conv\n\ntask run\n  like number\n  back add(a-conv(1), b-conv(1))\n',
  mod => mod.run!() === 103,
)

// and the same alias nested two calls deep in a lean call, where a label nesting dropped it (lean-nest `leanLabelOf`)
await run(
  'an alias nested two lean calls deep keeps its module',
  { '@app/a': CONV_A, '@app/b': CONV_B, '@app/twice': TWICE },
  'load @app/a\n  find conv, name a-conv\n\nload @app/b\n  find conv, name b-conv\n\nload @app/twice\n  find twice\n\ntask outer\n  take n, like number\n  like number\n  back add(n, 1000)\n\ntask run\n  like number\n  back outer(twice(a-conv(1)))\n',
  mod => mod.run!() === 1004,
)

// a plain find beside an alias of the same name: `find get` from the list and `find get, name vector-get` from a
// module's task. The bare name reaches the PLAIN find only (the scope's `plain`)
const VGET = 'form box\n  link items, like list, like number\n\ntask get\n  take b, like box\n  take i, like number\n  like number\n  back add(b/items/length, 50)\n'

await run(
  'a plain find and an alias of one name each reach their own',
  { '@app/box': VGET },
  'load @term/base/list\n  find get\n\nload @app/box\n  find box\n  find get, name box-get\n\ntask run\n  like number\n  save xs, make list(7, 8)\n  save b\n    make box\n      bind items, xs\n  back add(get(xs, 1), box-get(b, 0))\n',
  mod => mod.run!() === 60,
)

// two modules' `host` of one name: each module reads its own (check/overload.ts `bindHostsApart`)
await run(
  'two modules\' hosts of one name each read their own',
  { '@app/x': 'host limit, 5\n\ntask x-limit\n  like number\n  back limit\n', '@app/y': 'host limit, 7\n\ntask y-limit\n  like number\n  back limit\n' },
  'load @app/x\n  find x-limit\n\nload @app/y\n  find y-limit\n\ntask run\n  like number\n  back add(x-limit(), y-limit())\n',
  mod => mod.run!() === 12,
)

// the same program natively: each emitter read a case's fields by its name alone too
const ropeMain = 'load @app/rope\n  find rope\n  find make-rope\n  find length, name rope-length\n\nload @app/vector\n  find vector\n  find size-of\n\ntask total\n  like number\n  back rope-length(make-rope(<abc>, 3))\n'
const ropeFiles: Record<string, string> = { '@app/rope': ROPE, '@app/vector': VECTOR }
const ropeResolve = (path: string, ...rest: unknown[]): Source | undefined =>
  ropeFiles[path] !== undefined
    ? { file: `/app/code/${path.slice('@app/'.length)}.tree`, text: ropeFiles[path]! }
    : (projectResolver(process.cwd(), 'rust') as (...a: unknown[]) => Source | undefined)(path, ...rest)
const native = compile({ file: '/app/code/main.tree', text: ropeMain }, { resolve: ropeResolve as never, leanOf: () => true, env: 'rust', entryPoints: ['total'] })

if (!native.ok) {
  ok('the case program builds for rust', false, native.diagnostics.map(d => d.message).join(' | '))
} else if (spawnSync('rustc', ['--version']).status !== 0) {
  console.log('skip  rustc  (not installed)')
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-lean-binding-'))
  writeFileSync(join(dir, 'main.rs'), `${emitRust(native.program)}\nfn main() {\n    println!("{}", total());\n}\n`)
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', join(dir, 'main'), join(dir, 'main.rs')], { encoding: 'utf8' })
  ok('rustc compiles the case program', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

  if (out.status === 0) {
    const ran = spawnSync(join(dir, 'main'), [], { encoding: 'utf8' })
    ok('Rust reads its own form\'s case', ran.stdout.trim() === '3', ran.stdout.trim())
  }
}

console.log(`\nlean-binding: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
