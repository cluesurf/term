// Where Swift's `try` goes (compile/swift.ts, `openTry`): a call to a raising task writes its own `(try f())`, which an
// arithmetic or comparison operator beside it takes as it is, and a second `try` over the whole expression warns that
// it covers nothing. Under `&&` and `||` the right side is an autoclosure, which refuses a `try` inside it, so there
// the `try` covers the whole expression. Each program is typechecked by swiftc with warnings as errors.
// Run: npx tsx test/compile/swift-try.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'

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

if (spawnSync('swiftc', ['--version']).status !== 0) {
  console.log('swift-try: skipped, no swiftc')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'swift-try-'))

// the raising task every program calls, then the expression under test
const program = (body: string): string => `task half
  take n, like number
  like number
  fork test
    hook test
      call is-below
        read n
        code 0
    hook hold
      halt <negative>
  send back
    call divide
      read n
      code 2

task compute
  take n, like number
  like boolean
${body}`

function check(name: string, body: string, want: RegExp): void {
  const built = compile({ file: 'main.tree', text: program(body) }, { optimize: false })

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => d.message).join(' | '))

    return
  }

  const swift = emitSwift(built.program)
  const line = swift.split('\n').find(l => /return/.test(l) && /half/.test(l)) ?? ''
  const file = join(dir, `${name.replace(/\W+/g, '-')}.swift`)
  writeFileSync(file, swift)

  try {
    execFileSync('swiftc', ['-typecheck', '-warnings-as-errors', file], { stdio: ['ignore', 'pipe', 'pipe'] })
    ok(`${name}: typechecks with no warning`, true)
  } catch (error) {
    ok(`${name}: typechecks with no warning`, false, String((error as { stderr?: Buffer }).stderr ?? error).split('\n').slice(0, 4).join(' / '))
  }

  ok(`${name}: ${want}`, want.test(line), line.trim())
}

// a comparison over a raising call: the call's own `try`, none over the operator
check(
  'comparison',
  `  send back
    call is-equal
      call half
        read n
      code 2
`,
  /return \(\(try half\(n\)\) == 2\)/,
)

// arithmetic over a raising call, inside a comparison
check(
  'sum',
  `  send back
    call is-above
      call add
        read n
        call half
          read n
      code 3
`,
  /return \(\(n \+ \(try half\(n\)\)\) > 3\)/,
)

// `&&` with the raising call on its right, an autoclosure: the `try` in front of the whole
check(
  'and',
  `  send back
    call and
      call is-above
        read n
        code 0
      call is-equal
        call half
          read n
        code 2
`,
  /return \(try /,
)

console.log(`\nswift-try: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
