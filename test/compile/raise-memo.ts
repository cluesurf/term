// The whole program's raise sets, worked out once per per-module emit (decision 102 of
// term/self-host/change/001-finish-self-host, compile/modules.ts emitModules). Each module's emit of a program whose
// tasks raise across modules is written with one memo the modules share and with a fresh memo each: the bytes are the
// same, the shared memo is filled by the first emit and read, not worked out again, by the next, and an emit asking for
// other exceptions works its own out. Run: npx tsx test/compile/raise-memo.ts

import { compile } from '@term/make/code/compile/compile'
import { emitTypeScript, newRaiseMemo } from '@term/make/code/compile/typescript'
import type { Program } from '@term/make/code/compile/node'
import type { Source } from '@term/make/code/compile/load'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a stand-in for the stdlib's `exception` and `excess` (as test/compile/exception.ts has one), and a task raising it
const helper: Source = {
  file: 'helper.tree',
  text: `form exception
  head p
  link host, like text
  link form, like text
  link note, like text
  link code, like text
  link time, like number
  link link, like p

task exception-code
  like text
  send back, text <kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr>

task exception-time
  like number
  send back, code 7

form excess
  like exception
    bind note, <Too large>
    link thing, like text

task risky
  take n, like number
  like number
  fork test
    hook test
      call is-above
        read n
        code 10
    hook hold
      halt excess
        bind thing, text <n>
  send back, read n
`,
}

// a caller across the module line, which raises what `risky` raises
const entry = `load @app/helper
  find risky
  find excess

task loud
  take n, like number
  like number
  send back
    call risky
      read n
`

const resolve = (p: string): Source | undefined => (p === '@app/helper' ? helper : undefined)
const result = compile({ file: 'entry.tree', text: entry }, { resolve })

ok('compiles', result.ok, result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 2)))

if (result.ok) {
  const program = result.program
  const fileOf = (s: { span?: { file?: unknown } }): string | undefined => {
    const file = s.span?.file as { form?: string; value?: string } | string | undefined
    return typeof file === 'string' ? file : file?.form === 'some' ? file.value : undefined
  }
  const ofFile = (file: string): Program => program.filter(s => fileOf(s as never) === file) as Program
  const parts = [ofFile('helper.tree'), ofFile('entry.tree')]

  ok('both files have statements', parts.every(part => part.length > 0), parts.map(p => p.length).join(' '))

  const shared = newRaiseMemo()
  const withShared = parts.map(part => emitTypeScript(part, { context: program, exportConstants: true, raises: shared }))
  const kept = shared.sets
  ok('the first emit fills the shared memo', kept.form === 'some')
  const third = emitTypeScript(parts[1]!, { context: program, exportConstants: true, raises: shared })
  ok('a later emit reads it, never works it out again', shared.sets === kept)
  const withFresh = parts.map(part => emitTypeScript(part, { context: program, exportConstants: true }))

  ok('every module the same bytes with one memo and with one each', withShared.every((code, i) => code === withFresh[i]))
  ok('and again on a third emit', third === withFresh[1])

  const raises = kept.form === 'some' ? (kept.value as { raises: Map<string, string[]> }).raises : new Map()
  ok('the sets say the caller across the module line raises', (raises.get('loud') ?? []).includes('excess'), JSON.stringify([...raises]))

  const other = emitTypeScript(parts[1]!, { context: program, exportConstants: true, exceptions: new Set(['elsewhere']), raises: shared })
  const otherFresh = emitTypeScript(parts[1]!, { context: program, exportConstants: true, exceptions: new Set(['elsewhere']) })
  ok('an emit asking for other exceptions works its own out', other === otherFresh && shared.sets !== kept)
}

console.log(`\nraise-memo: ${pass} pass, ${fail} fail`)
if (fail) process.exit(1)
