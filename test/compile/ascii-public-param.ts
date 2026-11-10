// The ASCII text fact (ir/facts/ascii.tree) never takes a text parameter of a task that is not `mark private` as
// ASCII: such a task is exported, so a caller the build cannot see may pass any text. Until term-self-host-001-0059 a
// public task whose one caller in the build passed <abc> counted its parameter with `value.length` on TypeScript
// (`.len()`, `.utf8.count`, `.length` on Rust, Swift, Kotlin), so an outside call with astral text read 6 for 4.
// A private task called the same way keeps the fast path.
// Run: npx tsx test/compile/ascii-public-param.ts

import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { withNativeEnv } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { stdlibResolver } from '@term/make/code/resolve'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 600)}`)
  }
}

const source = (mark: string): string => `load @term/base/text
  find char-count

task size-of
  take value, like text
  like number
${mark}
  save n, char-count(value)
  fork test, is-above(n, 2)
    hold
      back n
  back add(n, 1)

task run
  like number

  back size-of(<abc>)
`

// the count of \`value\` each backend writes: the code-point form, or the fast ASCII form
const SLOW: Record<string, RegExp> = {
  node: /Array\.from\(value\)\.length/,
  rust: /value\.chars\(\)\.count\(\)/,
  swift: /value\.unicodeScalars\.count/,
  kotlin: /value\.codePointCount\(/,
}
const FAST: Record<string, RegExp> = {
  node: /n: number = value\.length/,
  rust: /let n = value\.len\(\)/,
  swift: /let n = value\.utf8\.count/,
  kotlin: /val n = value\.length\.toLong\(\)/,
}
const stdlib = stdlibResolver()!

function emitted(text: string, env: 'node' | 'rust' | 'swift' | 'kotlin'): string {
  const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv(env, stdlib), env })

  if (!built.ok) {
    return `NOT OK ${built.diagnostics.map(d => d.message).join(' | ')}`
  }
  return env === 'node'
    ? built.typescript
    : env === 'rust'
      ? emitRust(built.program)
      : env === 'swift'
        ? emitSwift(built.program)
        : emitKotlin(built.program)
}

async function main(): Promise<void> {
  for (const env of ['node', 'rust', 'swift', 'kotlin'] as const) {
    const open = emitted(source(''), env)
    ok(`${env}: a public task's text parameter is counted by code point`, SLOW[env]!.test(open) && !FAST[env]!.test(open), open)

    const closed = emitted(source('  mark private\n'), env)
    ok(`${env}: a private task called only with <abc> keeps the fast count`, FAST[env]!.test(closed), closed)
  }

  // what an outside caller gets: 4 code points, 6 UTF-16 units
  const ts = emitted(source(''), 'node')
  const js = transformSync(ts, { loader: 'ts', format: 'esm' }).code
  const mod = (await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)) as {
    sizeOf: (v: string) => number
  }
  const got = mod.sizeOf('a\u{1F600}b\u{1F600}')
  ok('node: an outside call of sizeOf with astral text counts code points', got === 4, `answered ${got}`)

  console.log(`\n${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
