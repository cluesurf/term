// Differential admission (deck/test/code/twin-diff.ts, optimize-0010): a twin is admitted as TESTED only when it agrees
// with its task on generated inputs in TypeScript and on the same inputs replayed on Rust, Swift and Kotlin, AND the
// comparison catches deliberately wrong copies of it. Held here both ways: the stdlib's two `count-each` twins are
// admitted, and a twin that skips the first value is refused with the smallest input that shows it.
// Run: npx tsx test/compile/twin-diff.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeFlags } from './native-flags'
import { admit, cache, REPLAY_TASK } from '@term/test/code/twin-diff'
import { compile } from '@term/make/code/compile/compile'
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
const stdlib = (path: string): Source | undefined => {
  const file = join(base, `${path.replace(/^@term\/base\//, '')}.tree`)

  return /^@term\/base\//.test(path) && existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
}
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const dir = mkdtempSync(join(tmpdir(), 'twin-diff-'))
const COUNT = readFileSync(join(base, 'code/count.tree'), 'utf8')

// the replay driver on one toolchain: built with the twins exposed, run, its line returned
function nativeRun(env: 'rust' | 'swift' | 'kotlin', text: string): { ok: true; out: string } | { ok: false; why: string } {
  const tools = { rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }[env]

  if (tools.some(t => !have(t))) {
    return { ok: false, why: `${tools.join(', ')} not installed` }
  }

  const built = compile({ file: join(dir, `replay-${env}.tree`), text }, { resolve: withNativeEnv(env, stdlib), env, exposeTwins: true, cache })

  if (!built.ok) {
    return { ok: false, why: built.diagnostics.map(d => d.message).join(' | ').slice(0, 300) }
  }

  const prelude = nativePrelude(built.program, env, readRuntime)
  const name = Math.random().toString(36).slice(2)

  try {
    if (env === 'rust') {
      const file = join(dir, `${name}.rs`)
      writeFileSync(file, `${prelude}\n${emitRust(built.program)}\nfn main() { print!("{}", ${REPLAY_TASK.replace(/-/g, '_')}()); }\n`)
      execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', join(dir, name)], { stdio: ['ignore', 'pipe', 'pipe'] })

      return { ok: true, out: execFileSync(join(dir, name)).toString() }
    }

    const call = REPLAY_TASK.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())

    if (env === 'swift') {
      const file = join(dir, `${name}.swift`)
      writeFileSync(file, `${prelude}\n${emitSwift(built.program)}\nprint(${call}(), terminator: "")\n`)
      execFileSync('swiftc', [...nativeFlags('swift'), '-o', join(dir, name), file], { stdio: ['ignore', 'pipe', 'pipe'] })

      return { ok: true, out: execFileSync(join(dir, name)).toString() }
    }

    const file = join(dir, `${name}.kt`)
    writeFileSync(file, hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main() { print(${call}()) }\n`))
    execFileSync('kotlinc', [file, ...nativeFlags('kotlin'), '-include-runtime', '-d', join(dir, `${name}.jar`)], { stdio: ['ignore', 'pipe', 'pipe'] })

    return { ok: true, out: execFileSync('java', ['-jar', join(dir, `${name}.jar`)]).toString() }
  } catch (error) {
    return { ok: false, why: String((error as { stderr?: Buffer }).stderr ?? error).split('\n').filter(l => /error/.test(l)).slice(0, 3).join(' | ') }
  }
}

async function main(): Promise<void> {
  // 1. the stdlib's twins: admitted, everywhere
  const good = await admit({ source: { file: join(base, 'code/count.tree'), text: COUNT }, resolve: stdlib, dir, cases: 2000, native: 30, nativeRun })

  if (!good.ok) {
    ok('count.tree builds for admission', false, good.reason)
  } else {
    for (const verdict of good.verdicts) {
      ok(`count-each/${verdict.twin} is admitted as tested: ${verdict.reason}`, verdict.admitted, verdict.reason)
      ok(`count-each/${verdict.twin} catches deliberately wrong copies of itself`, verdict.mutants.caught > 0, JSON.stringify(verdict.mutants))

      for (const [env, result] of Object.entries(verdict.native)) {
        ok(`count-each/${verdict.twin} on ${env}: ${result}`, result.startsWith('agreed') || result.startsWith('not replayed: ') && /not installed/.test(result), result)
      }
    }

    ok('both twins were judged', good.verdicts.length === 2, JSON.stringify(good.verdicts.map(v => v.twin)))
  }

  // 2. a wrong twin: skips the first value. Refused, with the smallest input that shows it
  const wrong = `${COUNT}
twin count-each, name skips-first
  take values
  take queries
  save counts
    make list
  walk list, read queries
    hook next
      take site, name query
      save count, code 0
      save first, true
      walk list, read values
        hook next
          take site, name value
          fork test
            hook test
              read first
            hook hold
              save first, false
            hook miss
              fork test
                hook test
                  call is-equal
                    read value
                    read query
                hook hold
                  save count
                    call add
                      read count
                      code 1
      call push
        bind list, read counts
        bind item, read count
  send back, read counts
`
  const bad = await admit({ source: { file: join(dir, 'wrong.tree'), text: wrong }, resolve: stdlib, dir, cases: 2000, native: 0 })

  if (!bad.ok) {
    ok('the module with a wrong twin builds for admission', false, bad.reason)
  } else {
    const verdict = bad.verdicts.find(v => v.twin === 'skips-first')
    ok('a twin that skips the first value is NOT admitted', verdict !== undefined && !verdict.admitted, verdict?.reason)
    // the smallest disagreement: one value, asked for once, counted once by the task and never by the twin
    const input = verdict?.disagreement?.input as number[][] | undefined
    ok(
      'its disagreement is shrunk to one value and one query',
      input !== undefined && input[0]!.length === 1 && input[1]!.length === 1,
      verdict?.disagreement ? `${verdict.disagreement.literal}: ${verdict.reason}` : 'no disagreement recorded',
    )
    ok('the right twins in the same module are still admitted', bad.verdicts.filter(v => v.twin !== 'skips-first').every(v => v.admitted))
  }

  // 3. a twin whose task takes a form: no generator, so it is refused with the type named, never tested on nothing
  const formed = `form point
  link x, like number

task double-x
  take p, like point
  like number
  send back
    call multiply
      read p/x
      code 2

twin double-x, name shift
  take p
  send back
    call add
      read p/x
      read p/x
`
  const odd = await admit({ source: { file: join(dir, 'formed.tree'), text: formed }, resolve: stdlib, dir, native: 0 })
  const shift = odd.ok ? odd.verdicts[0] : undefined
  ok('a twin over a type with no generator is not admitted, and says which type', shift !== undefined && !shift.admitted && /no generator for `point`/.test(shift.reason), shift?.reason ?? (odd.ok ? '' : odd.reason))

  console.log(`\ntwin-diff: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
