// A `number` is the integer or the program stops (note/term/proof-by-default/numbers.md), at the edges where a host
// integer type wraps in silence: the minimum divided by -1, a difference below the minimum, and a product past the
// maximum. Each program takes its operand as a PARAMETER (2^62), so no compiler folds the edge away, runs on every
// backend, and must end with a non-zero exit, never print an integer. Kotlin's `MIN / -1` wrapped to MIN, a different
// integer, until 2026-10-02 (codegen-performance-0003).
// Run: npx tsx test/compile/integer-edges.ts   (IE_ONLY=rust, swift, kotlin or typescript runs one)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'

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

const have = (tool: string): boolean => spawnSync('which', [tool]).status === 0
const base = join(import.meta.dirname, '../../deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const dir = mkdtempSync(join(tmpdir(), 'integer-edges-'))
const only = process.env.IE_ONLY ?? ''

// the minimum from a parameter: 0 - x - x with x = 2^62 is -2^63 exactly, in range on every 64-bit backend
const minimum = `  save low
    call subtract
      call subtract
        code 0
        read x
      read x`

const EDGES: Record<string, string> = {
  'minimum divided by -1': `${minimum}
  send back
    call divide
      read low
      code -1`,
  'a difference below the minimum': `${minimum}
  send back
    call subtract
      read low
      code 1`,
  'a product past the maximum': `  send back
    call multiply
      read x
      code 2`,
}

// a list read or write outside the list stops too, never reading `undefined` or wrapping an index. The index is built
// from the parameter (x - x + 1, and 0 - 1) so nothing folds it. TypeScript writes these checks in place since
// 2026-10-02 (typescript.ts, readAt), so this holds the inline form as well as `__termAt`
const oneItem = `  save xs
    make list
  call push
    bind list, read xs
    bind item, code 7
  save past
    call add
      call subtract
        read x
        read x
      code 1
  save before
    call subtract
      call subtract
        read x
        read x
      code 1`
EDGES['a list read one past the end'] = `${oneItem}
  send back, read xs/{past}`
EDGES['a list read at -1'] = `${oneItem}
  send back, read xs/{before}`
EDGES['a list write one past the end'] = `${oneItem}
  save xs/{past}, code 9
  send back, read xs/0`
// a counted loop that reads one slot past the end: the loop is guarded (ir/facts/bounds.ts) and the guard is false here,
// so the checked copy runs and stops where it always did. `past` is 1 and the list has one item, so `i < past + 1`
// reaches i = 1
EDGES['a counted loop reading one past the end'] = `${oneItem}
  save total, code 0
  save i, code 0
  save upto
    call add
      read past
      code 1
  walk test
    hook test
      call is-below
        read i
        read upto
    hook hold
      save total
        call add
          read total
          read xs/{i}
      save i
        call add
          read i
          code 1
  send back, read total`

// the swap of two slots is one native call on Swift, Rust and Kotlin (backend.ts, swapAt): either index outside the
// list still stops, as the three statements it replaces stop
const zero = `
  save at
    call subtract
      read x
      read x`
EDGES['a swap with one index past the end'] = `${oneItem}${zero}
  host t, read xs/{at}
  save xs/{at}, read xs/{past}
  save xs/{past}, read t
  send back, read xs/0`
EDGES['a swap with one index at -1'] = `${oneItem}${zero}
  host t, read xs/{before}
  save xs/{before}, read xs/{at}
  save xs/{at}, read t
  send back, read xs/0`

// the native integer power (imath.pow on Rust, Swift and Kotlin), squared past the maximum: it went through Double on
// Swift and Kotlin and saturated, and wrapped on a Rust release build. Not TypeScript, whose native power is
// JavaScript's float `Math.pow` by design
EDGES['a native power past the maximum'] = `  send back
    call pow
      read x
      code 2`

const program = (body: string): string => `${body.includes('call pow') ? 'load @term/base/code/native/{platform}/math\n  find pow\n\n' : ''}${body.includes('call push') ? 'load @term/base/code/list\n  find list\n\n' : ''}task edge
  take x, like number
  like number
${body}
`

for (const [label, body] of Object.entries(EDGES)) {
  for (const target of ['typescript', 'rust', 'swift', 'kotlin'] as const) {
    if (only && only !== target) continue

    if (label.startsWith('a native power') && target === 'typescript') continue

    const tools = { typescript: ['node'], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }[target]

    if (tools.some(t => !have(t))) {
      console.log(`skip  ${target}: ${label} (${tools.join(', ')} not installed)`)
      continue
    }

    const env = target === 'typescript' ? 'node' : target
    const built = compile({ file: join(dir, 'edge.tree'), text: program(body) }, { resolve: withNativeEnv(env, stdlib), env })

    if (!built.ok) {
      ok(`${target}: ${label} builds`, false, built.diagnostics.map(d => d.message).join(' | '))
      continue
    }

    const prelude = nativePrelude(built.program, env as never, readRuntime)
    const stem = join(dir, `${target}-${label.replace(/\W+/g, '-')}`)
    let command: string[]

    try {
      if (target === 'typescript') {
        writeFileSync(`${stem}.ts`, `${prelude}\n${built.typescript}\nconsole.log(edge(4611686018427387904))\n`)
        command = ['npx', 'tsx', `${stem}.ts`]
      } else if (target === 'rust') {
        writeFileSync(`${stem}.rs`, `${prelude}\n${emitRust(built.program)}\nfn main() { println!("{}", edge(4611686018427387904)); }\n`)
        execFileSync('rustc', ['-A', 'warnings', '-C', 'opt-level=3', `${stem}.rs`, '-o', stem], { stdio: ['ignore', 'pipe', 'pipe'] })
        command = [stem]
      } else if (target === 'swift') {
        writeFileSync(`${stem}.swift`, `${prelude}\n${emitSwift(built.program)}\nprint(edge(x: 4611686018427387904))\n`)
        execFileSync('swiftc', ['-O', '-o', stem, `${stem}.swift`], { stdio: ['ignore', 'pipe', 'pipe'] })
        command = [stem]
      } else {
        writeFileSync(`${stem}.kt`, hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main() { println(edge(4611686018427387904L)) }\n`))
        execFileSync('kotlinc', [`${stem}.kt`, '-nowarn', '-include-runtime', '-d', `${stem}.jar`], { stdio: ['ignore', 'pipe', 'pipe'] })
        command = ['java', '-jar', `${stem}.jar`]
      }
    } catch (error) {
      ok(`${target}: ${label} builds`, false, String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 400))
      continue
    }

    const ran = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8' })
    ok(`${target}: ${label} stops instead of answering`, ran.status !== 0 && !/^-?\d+\s*$/.test(ran.stdout), `exit ${ran.status}, printed ${JSON.stringify(ran.stdout.trim())}`)
  }
}

// and the native power is EXACT where it fits: 3^39 is past 2^53, where a Double rounds it to a different integer
for (const target of ['rust', 'swift', 'kotlin'] as const) {
  if (only && only !== target) continue

  const tools = { rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }[target]

  if (tools.some(t => !have(t))) continue

  const text = `load @term/base/code/native/{platform}/math
  find pow

task edge
  take x, like number
  like number
  send back
    call pow
      read x
      code 39
`
  const built = compile({ file: join(dir, 'exact.tree'), text }, { resolve: withNativeEnv(target, stdlib), env: target })

  if (!built.ok) {
    ok(`${target}: the exact power builds`, false, built.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const prelude = nativePrelude(built.program, target, readRuntime)
  const stem = join(dir, `${target}-exact`)
  let got = ''

  try {
    if (target === 'rust') {
      writeFileSync(`${stem}.rs`, `${prelude}\n${emitRust(built.program)}\nfn main() { println!("{}", edge(3)); }\n`)
      execFileSync('rustc', ['-A', 'warnings', '-C', 'opt-level=3', `${stem}.rs`, '-o', stem], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem).toString().trim()
    } else if (target === 'swift') {
      writeFileSync(`${stem}.swift`, `${prelude}\n${emitSwift(built.program)}\nprint(edge(x: 3))\n`)
      execFileSync('swiftc', ['-O', '-o', stem, `${stem}.swift`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem).toString().trim()
    } else {
      writeFileSync(`${stem}.kt`, hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main() { println(edge(3L)) }\n`))
      execFileSync('kotlinc', [`${stem}.kt`, '-nowarn', '-include-runtime', '-d', `${stem}.jar`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync('java', ['-jar', `${stem}.jar`]).toString().trim()
    }
  } catch (error) {
    got = String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 300)
  }

  ok(`${target}: the native power of 3 to 39 is exact`, got === '4052555153018976267', got)
}

console.log(`\ninteger-edges: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
