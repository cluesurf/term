// Nested `walk size` loops on the native backends (note/term/gaps/plan.md, phase 1). Both loops named their counter
// `i`, so on TypeScript the outer loop never ended (guides: language/loops, 2026-10-03). The bridge now renames each
// counter apart, and a `take` beside the `bind` lines names it. test/compile/guide-gaps.ts runs both samples on
// TypeScript; this builds and runs them with rustc, swiftc and kotlinc. A backend whose toolchain is missing is
// skipped, never failed.
//
// It also runs the `hook miss` arm of a `sift`, the catch-all (phase 2, language/matching, 2026-10-04): `corners`
// lists `square` and answers every other shape through the miss arm, and `probe-shapes` folds three answers into one
// number, 4 for a square, 0 for a circle and for a dot. And `walk size` with a `step` (by 2 to 12, down by 1 to 321)
// and `turn next` inside a counted walk, which jumped past the counter's step and never ended (to 6).
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

form shape
  case circle
    link r, like number
  case square
    link side, like number
  case dot

task corners
  take s, like shape
  like number
  sift s
    case square
      send back, code 4
    hook miss
      send back, code 0

task probe-shapes
  like number
  send back
    call add
      call multiply
        call corners
          make square
            bind side, code 2
        code 100
      call add
        call multiply
          call corners
            make circle
              bind r, code 1
          code 10
        call corners
          make dot
`

const STEPS = `
task evens
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, code 0
    bind head, read n
    bind step, code 2
    hook next
      save total
        call add
          read total
          read i
  send back, read total

task down
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, read n
    bind head, code 0
    bind step, code -1
    hook next
      save total
        call add
          call multiply
            read total
            code 10
          read i
  send back, read total

task skip-odd
  take n, like number
  like number
  save total, code 0
  walk size
    take i
    bind base, code 0
    bind head, read n
    hook next
      fork test
        hook test
          call is-equal
            call modulo
              read i
              code 2
            code 1
        hook hold
          turn next
      save total
        call add
          read total
          read i
  send back, read total
`

const EXPECTED = '16 10 400 12 321 6'

for (const target of ['rust', 'swift', 'kotlin'] as const) {
  if (only && only !== target) {
    continue
  }

  const tools = { rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }[target]

  if (tools.some(tool => !have(tool))) {
    console.log(`skip  ${target}  (no ${tools.join(' or ')})`)
    continue
  }

  const built = compile({ file: join(dir, `${target}.tree`), text: PROGRAM + STEPS }, { resolve: withNativeEnv(target, stdlib), env: target })

  if (!built.ok) {
    ok(`${target}: the loops build`, false, built.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const prelude = nativePrelude(built.program, target, readRuntime)
  const stem = join(dir, target)
  let got = ''

  try {
    if (target === 'rust') {
      writeFileSync(`${stem}.rs`, `${prelude}\n${emitRust(built.program)}\nfn main() { println!("{} {} {} {} {} {}", grid(4), sum_to(5), probe_shapes(), evens(7), down(3), skip_odd(6)); }\n`)
      execFileSync('rustc', ['-A', 'warnings', `${stem}.rs`, '-o', stem], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem, { timeout: 10_000 }).toString().trim()
    } else if (target === 'swift') {
      writeFileSync(`${stem}.swift`, `${prelude}\n${emitSwift(built.program)}\nprint("\\(grid(n: 4)) \\(sumTo(n: 5)) \\(probeShapes()) \\(evens(n: 7)) \\(down(n: 3)) \\(skipOdd(n: 6))")\n`)
      execFileSync('swiftc', ['-o', stem, `${stem}.swift`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync(stem, { timeout: 10_000 }).toString().trim()
    } else {
      writeFileSync(`${stem}.kt`, hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main() { println("\${grid(4L)} \${sumTo(5L)} \${probeShapes()} \${evens(7L)} \${down(3L)} \${skipOdd(6L)}") }\n`))
      execFileSync('kotlinc', [`${stem}.kt`, '-nowarn', '-include-runtime', '-d', `${stem}.jar`], { stdio: ['ignore', 'pipe', 'pipe'] })
      got = execFileSync('java', ['-jar', `${stem}.jar`], { timeout: 10_000 }).toString().trim()
    }
  } catch (error) {
    got = String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 600)
  }

  ok(`${target}: both loops end (grid(4) = 16, sum-to(5) = 10), a sift's miss arm answers every case it does not list (400), and a stepped, a downward and a turn-next walk (12 321 6)`, got === EXPECTED, got)
}

console.log(`\nwalk-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
