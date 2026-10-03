// Nested `walk size` loops on the native backends (note/term/gaps/plan.md, phase 1). Both loops named their counter
// `i`, so on TypeScript the outer loop never ended (guides: language/loops, 2026-10-03). The bridge now renames each
// counter apart, and a `take` beside the `bind` lines names it. test/compile/guide-gaps.ts runs both samples on
// TypeScript; this builds and runs them with rustc, swiftc and kotlinc. A backend whose toolchain is missing is
// skipped, never failed.
// Run: npx tsx test/compile/walk-native.ts   (WN_ONLY=rust, swift or kotlin runs one)

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
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
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const dir = mkdtempSync(join(tmpdir(), 'walk-native-'))
const only = process.env.WN_ONLY ?? ''

// the guide's two loops, and the counter named by a `take`: 4 x 4 turns, and 0 + 1 + 2 + 3 + 4
const PROGRAM = `task grid
  take n, like number
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      walk size
        bind base, code 0
        bind head, read n
        hook next
          save total
            call add
              read total
              code 1
  send back, read total

task sum-to
  take n, like number
  like number
  save total, code 0
  walk size
    take j
    bind base, code 0
    bind head, read n
    hook next
      save total
        call add
          read total
          read j
  send back, read total
`

const EXPECTED = '16 10'

for (const target of ['rust', 'swift', 'kotlin'] as const) {
  if (only && only !== target) {
    continue
  }

  const tools = { rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }[target]

  if (tools.some(tool => !have(tool))) {
    console.log(`skip  ${target}  (no ${tools.join(' or ')})`)
    continue
  }

  const built = compile({ file: join(dir, `${target}.tree`), text: PROGRAM }, { resolve: withNativeEnv(target, stdlib), env: target })

  if (!built.ok) {
    ok(`${target}: the loops build`, false, built.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const prelude = nativePrelude(built.program, target, readRuntime)
  const stem = join(dir, target)
  let got = ''

  try {
    if (target === 'rust') {
      writeFileSync(`${stem}.rs`, `${prelude}\n${emitRust(built.program)}\nfn main() { println!("{} {}", grid(4), sum_to(5)); }\n`)
      execFileSync('rustc', ['-A', 'warnings', `${stem}.rs`, '-o', stem], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem, { timeout: 10_000 }).toString().trim()
    } else if (target === 'swift') {
      writeFileSync(`${stem}.swift`, `${prelude}\n${emitSwift(built.program)}\nprint("\\(grid(4)) \\(sumTo(5))")\n`)
      execFileSync('swiftc', ['-o', stem, `${stem}.swift`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem, { timeout: 10_000 }).toString().trim()
    } else {
      writeFileSync(`${stem}.kt`, hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main() { println("\${grid(4L)} \${sumTo(5L)}") }\n`))
      execFileSync('kotlinc', [`${stem}.kt`, '-nowarn', '-include-runtime', '-d', `${stem}.jar`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync('java', ['-jar', `${stem}.jar`], { timeout: 10_000 }).toString().trim()
    }
  } catch (error) {
    got = String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 600)
  }

  ok(`${target}: both loops end, with grid(4) = 16 and sum-to(5) = 10`, got === EXPECTED, got)
}

console.log(`\nwalk-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
