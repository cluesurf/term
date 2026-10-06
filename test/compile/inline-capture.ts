// The inliner's hygiene at a match arm (ir/simplify.ts, `boundNames`). A forwarder whose target is a member of a
// native module, `time/uptime`, inlined where an arm binds a field of the same name, reads the field: the call becomes
// `time.uptime()` on a number. Each arm binds its case's fields by their own names (or by its `link` lines), and an
// arm over a caught exception binds every shared field, so those names block the inlining as a `let` does.
//
// Found 2026-10-04 on Swift and Kotlin, where the stdlib's `exception-time` (`call now`, a member of the runtime's
// `time`) was inlined into an exception arm that bound the caught `time`, and the file did not build
// (note/term/stdlib/regex-engine.md, "Found on the way"). This holds it on TypeScript, at run time, on both arm kinds.
// Run: npx tsx test/compile/inline-capture.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

const SOURCE = `load @term/base/exception
  find absence

dock load
  load <node:os>, name time

# a forwarder to a member of the native module named \`time\`
task up-for
  like number
  send back
    call time/uptime

form stamp
  case dated
    link time, like number
  case blank

# an ordinary union's arm binds \`time\` by its own name
task stamped
  like number
  save s
    make dated
      bind time, code 5
  fork case, read s
    case dated
      send back
        call add
          read time
          call up-for
    case blank
      send back, code 0

task fail-now
  like number
  halt absence
    bind thing, text <clock>

# an arm over a caught exception binds every shared field, \`time\` among them
task caught-up
  like number
  fork
    mark unsafe
    send back, call fail-now
  halt take
    take problem
    fork case, read problem
      case absence
        send back
          call add
            call up-for
            fork test
              hook test
                call is-above
                  read time
                  code 0
              hook hold
                code 1
              hook miss
                code 0
`

async function main(): Promise<void> {
  const result = compile(
    { file: join(process.cwd(), 'test', 'compile', 'inline-capture.tree'), text: SOURCE },
    { resolve: withNativeEnv('node', stdlibResolver()!), env: 'node' },
  )
  ok('the program compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

  if (!result.ok) {
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-inline-capture-'))
  const file = join(dir, 'p.mjs')
  writeFileSync(file, transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = await import(pathToFileURL(file).href)

  let union: unknown
  let caught: unknown

  try {
    union = mod.stamped()
  } catch (error) {
    union = `raised: ${error instanceof Error ? error.message : String(error)}`
  }

  try {
    caught = mod.caughtUp()
  } catch (error) {
    caught = `raised: ${error instanceof Error ? error.message : String(error)}`
  }

  ok('a union arm binding `time` still calls the module', typeof union === 'number' && union > 5, String(union))
  ok('an exception arm binding `time` still calls the module', typeof caught === 'number' && caught > 1, String(caught))
}

await main()
console.log(`\ninline-capture: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
