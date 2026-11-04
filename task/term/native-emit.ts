// Emit one stdlib module for one native backend, to stdout: the runtime-shim prelude plus the compiled source, exactly
// what `pnpm term:native-gate` hands to cargo / swiftc / kotlinc.
//
// The gate answers pass or fail. This answers WHY, which is the question you have while writing a native module: what
// did the shim resolve to, what did the form become, where did the `.await` land. Reading emitted code is the only way
// to see a mangled name (`move` -> `move_`, `dir-list` -> `dirList`) or a missing shim before a toolchain error does.
//
//   pnpm term:native-emit rust deck/base/code/native/rust/file/asynchronous.tree
//   pnpm term:native-emit kotlin deck/base/code/file.tree
//
// Paths are relative to `the Term root`, the way every other term task runs. Check errors print to stderr and do
// not stop the emit, so a half-checked module can still be read.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve as resolvePath, dirname } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program, Statement } from '@term/make/code/compile/node'
import { TERM_ROOT } from './root'

type Env = 'rust' | 'swift' | 'kotlin' | 'node' | 'browser'

const TERM = TERM_ROOT
const SEED = join(TERM, 'deck/base')

const env = process.argv[2] as Env
const target = process.argv[3]

if (!env || !target) {
  console.error(
    'usage: pnpm term:native-emit <rust|swift|kotlin|node|browser> <path/to/module.tree>',
  )
  process.exit(2)
}

const file = resolvePath(target)

// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
// and a relative path beside its importer
const stdlibOf = stdlibResolver()

const resolver = (path: string, from?: string): Source | undefined => {
  if (path.startsWith('@term/base')) {
    return stdlibOf?.(path, from ?? '')
  }

  if (!path.startsWith('.') || !from) {
    return undefined
  }

  const base = resolvePath(dirname(from), path)

  for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

const readRuntime = (path: string): string | undefined =>
  existsSync(path) ? readFileSync(path, 'utf8') : undefined

const text = readFileSync(file, 'utf8')
const { sources, scope } = collectModules(
  { file, text },
  withNativeEnv(env, resolver),
)
const program: Program = []
const ownNames = new Set<string>()

for (const unit of sources) {
  const parsed = parse(unit)

  if (!parsed.ok) {
    console.error(`parse  ${unit.file}  ${parsed.diagnostics[0]?.message}`)
    process.exit(1)
  }

  const built = mill(expandTemplates(parsed.tree), unit.file)

  if (!built.ok) {
    console.error(`mill  ${unit.file}  ${built.diagnostics[0]?.message}`)
    process.exit(1)
  }

  if (unit.file === file) {
    for (const statement of built.program) {
      if (statement.form === 'function') {
        ownNames.add(statement.name)
      }
    }
  }

  stampModule(built.program, unit.file)
  program.push(...built.program)
}

// module scope and form extension, as `compileProgram` runs them (check/bind-modules.ts)
for (const error of bindModules(program, scope, file)) {
  console.error(`scope  ${error.span.file ?? file}:${error.span.start.line + 1}  ${error.message}`)
  process.exit(1)
}

resolveNames(program, file)

for (const error of check(program, file).filter(
  d => d.severity !== 'warning',
)) {
  console.error(`check  ${error.message}`)
}

resolveAsync(program)

const simple = simplify(
  program,
  ownNames.size > 0
    ? ownNames
    : new Set(
        program
          .filter(
            (s): s is Extract<Statement, { form: 'function' }> =>
              s.form === 'function',
          )
          .map(s => s.name),
      ),
)

// node and browser are TypeScript. Falling through to the kotlin emitter for them printed kotlin syntax under a
// node heading, which reads as a compiler bug for as long as it takes to notice the `suspend fun`.
const emitted =
  env === 'rust'
    ? emitRust(simple)
    : env === 'swift'
      ? emitSwift(simple)
      : env === 'kotlin'
        ? emitKotlin(simple)
        : emitTypeScript(simple)
const prelude = nativePrelude(simple, env, readRuntime)

console.log(
  env === 'kotlin'
    ? hoistKotlinImports(`${prelude}\n${emitted}`)
    : `${prelude}\n${emitted}`,
)
