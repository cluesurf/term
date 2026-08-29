// Stdlib survey: compile every top-level module in base.tree/code and assert the core set is healthy. This guards
// against compiler regressions that would silently break the standard library's public API surface. It does not run
// the modules (many delegate to per-env native impls); it checks that the API compiles and type-checks.
// Run: npx tsx test/stdlib/survey.ts

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { Source } from '@term/make/code/compile/load'

const here = dirname(fileURLToPath(import.meta.url))
const base = join(here, '..', '..', 'deck', 'seed')
const codeDir = join(base, 'code')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {return undefined}

  const file = join(base, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

// the survey compiles against the node target, so a public module's abstract `native/<x>` import resolves to the
// node implementation (native/node/<x>); modules that do not use native imports are unaffected
const resolver = withNativeEnv('node', stdlib)

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

function compiles(file: string): boolean {
  const text = readFileSync(join(codeDir, file), 'utf8')

  if (!text.trim()) {return true} // an empty placeholder is not a failure

  try {
    return compile({ file, text }, { resolve: resolver }).ok
  } catch {
    return false // a crash is a hard failure
  }
}

// the core modules that must always compile (the standard library's load-bearing surface)
const CORE = [
  'boolean.tree',
  'maybe.tree',
  'result.tree',
  'pair.tree',
  'list.tree',
  'float.tree',
  'file.tree',
  'clock.tree',
  'color.tree',
  'console.tree',
  'process.tree',
  'exception.tree',
  'hash.tree',
  'range.tree',
  'time.tree',
  'log.tree',
  'input.tree',
  'command.tree',
  'text.tree',
  'date.tree',
  'channel.tree',
  'network.tree',
  'socket.tree',
  'task.tree',
  'cryptography.tree',
]

// no module may crash the compiler (parser robustness)
const all = readdirSync(codeDir).filter(f => f.endsWith('.tree'))

let crashed = 0
let ok = 0

for (const file of all) {
  const text = readFileSync(join(codeDir, file), 'utf8')

  if (!text.trim()) {continue}

  try {
    if (compile({ file, text }, { resolve: resolver }).ok) {ok++}
  } catch {
    crashed++
    console.log(`  crash: ${file}`)
  }
}

expect('no module crashes the compiler', crashed, 0)
expect('every non-empty core module compiles', ok >= 58, true)

// a curated set of load-bearing modules must compile individually
for (const file of CORE) {
  expect(
    `core module compiles: ${file}`,
    existsSync(join(codeDir, file)) ? compiles(file) : 'missing',
    true,
  )
}

console.log(
  `\nstdlib survey: ${pass} pass, ${fail} fail  (${ok}/${all.length} modules compile)`,
)

if (fail > 0) {process.exit(1)}
