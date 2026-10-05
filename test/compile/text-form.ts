// A closed set of texts (D9, decided 2026-10-04): a form marked `mark text` whose cases carry no fields, each case its
// text, `case plus, text <+>`, or its own name in snake_case. On TypeScript a value IS its text, so the type is the
// string-literal union the compiler's own TypeScript declares (`"+" | "-"`), a construction is the literal, and a
// match compares strings. A TypeScript caller passes `"+"` and gets `"+"` back. Natively it is a field-less enum.
// Each program is built AND run. Run: npx tsx test/compile/text-form.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

const text = `form binary-op
  mark text
  case plus, text <+>
  case minus, text <->
  case times, text <*>
  case less-equal

task apply
  take op, like binary-op
  take a, like number
  take b, like number
  like number
  sift op
    case plus
      back add(a, b)
    case minus
      back subtract(a, b)
    case times
      back multiply(a, b)
    case less-equal
      back 0

task pick
  take n, like number
  like binary-op
  fork test, is-equal(n, 0)
    hold
      back make plus
  fork test, is-equal(n, 1)
    hold
      back make minus
  back make less-equal

task same-op
  take a, like binary-op
  take b, like binary-op
  like boolean
  back is-equal(a, b)

task name-of
  take op, like binary-op
  like text
  back to-text(op)

task parse-op
  take written, like text
  like binary-op
  save fallback, make less-equal
  back from-text(written, fallback)

task total
  like number
  save times, make times
  back add(apply(pick(0), 2, 3), apply(times, 4, 5))
`

const built = compile({ file: '/gate/code/text-form.tree', text }, { leanOf: () => true })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const ts = built.typescript
  const declared = /type BinaryOp =([^;]*?)\n\n/.exec(`${ts}\n\n`)?.[1]?.replace(/\s+/g, ' ').trim() ?? ''
  ok('the type is the union of its texts', declared === '| "+" | "-" | "*" | "less_equal"', declared)

  const dir = mkdtempSync(join(tmpdir(), 'term-text-form-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(ts, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>

  ok('a construction is its text', mod.pick!(0) === '+' && mod.pick!(1) === '-', `${String(mod.pick!(0))} ${String(mod.pick!(1))}`)
  ok('a case with no text is its name in snake_case', mod.pick!(2) === 'less_equal', String(mod.pick!(2)))
  ok('a TypeScript caller passes the text, and the match reads it', mod.apply!('-', 9, 4) === 5 && mod.apply!('*', 3, 3) === 9)
  ok('two values compare as texts', mod.sameOp!('+', '+') === true && mod.sameOp!('+', '-') === false)
  ok('to-text is the case\'s text', mod.nameOf!('*') === '*' && mod.nameOf!('less_equal') === 'less_equal')
  ok('from-text reads a text back, else the fallback', mod.parseOp!('-') === '-' && mod.parseOp!('?') === 'less_equal')
  ok('built and matched inside Term', mod.total!() === 25, String(mod.total!()))
}

// natively a field-less enum: the program builds through rustc
const native = compile({ file: '/gate/code/text-form.tree', text }, { leanOf: () => true, resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['total', 'same-op', 'name-of', 'parse-op'] })

if (!native.ok) {
  ok('the program builds for rust', false, native.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else if (spawnSync('rustc', ['--version']).status !== 0) {
  console.log('skip  rustc  (not installed)')
} else {
  const rust = `${emitRust(native.program)}\nfn main() {\n    println!("{} {} {}", total(), name_of(&parse_op("*".to_string())), name_of(&parse_op("?".to_string())));\n}\n`
  const dir = mkdtempSync(join(tmpdir(), 'term-text-form-'))
  writeFileSync(join(dir, 'main.rs'), rust)
  const binary = join(dir, 'main')
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
  ok('rustc compiles it', out.status === 0, out.stderr.split('\n').slice(0, 30).join('\n        '))

  if (out.status === 0) {
    const ran = spawnSync(binary, [], { encoding: 'utf8' })
    ok('Rust answers what TypeScript does', ran.stdout.trim() === '25 * less_equal', ran.stdout.trim())
  }
}

// refused: a case that holds a value, and two cases with one text
const refused = (source: string): string => {
  const result = compile({ file: '/gate/code/bad.tree', text: source }, { leanOf: () => true })

  return result.ok ? '(built)' : result.diagnostics.map(d => d.message).join(' | ')
}

const holding = refused('form op\n  mark text\n  case plus, text <+>\n  case named\n    link value, like text\n\ntask run\n  like op\n  back make plus\n')
ok('a case that holds a value is refused', /cannot hold a value/.test(holding), holding)

const twice = refused('form op\n  mark text\n  case plus, text <+>\n  case add, text <+>\n\ntask run\n  like op\n  back make plus\n')
ok('two cases with one text are refused', /to both `plus` and `add`/.test(twice), twice)

console.log(`\ntext-form: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
