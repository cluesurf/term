// A dock of a host global spelled with a capital (`<global:JSON>`) has no runtime shim. Its shim was looked for at
// `runtime/JSON.rs`, and a file system that folds case (this Mac's) answered with `json.rs`, the shim of
// `<global:json>`: the Rust prelude of a program docking both held `mod json` twice, and rustc refused it (E0428). The
// CLI's entry met it (finding/native-entry.md of term/self-host/change/001-finish-self-host, item
// term-self-host-001-1054). The files are read here as a case-folding file system reads them, on any machine.
// Run: npx tsx test/compile/rust-prelude-case.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'

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

// a path read as a case-folding file system reads it: the file of its folder whose name is the same in lower case
function readFolded(path: string): string | undefined {
  const dir = dirname(path)

  if (!existsSync(dir)) {
    return undefined
  }

  const want = basename(path).toLowerCase()
  const found = readdirSync(dir).find(name => name.toLowerCase() === want)

  return found === undefined ? undefined : readFileSync(join(dir, found), 'utf8')
}

const docked = `dock load
  load <global:JSON>, name host-json

task shown
  take n, like number
  like text
  send back
    call host-json/stringify
      read n
`

// the stdlib's json, whose native module docks <global:json>, beside the host's JSON
const both = `load @term/base/json
  find from-number
  find stringify

${docked}
task both
  take n, like number
  like text
  save a, shown(n)
  save b
    call stringify
      call from-number
        read n
  send back, text <{a}{b}>
`

function preludeOf(text: string, entries: string[], env: NativeEnv): string | undefined {
  const built = compile(
    { file: '/gate/code/case.tree', text },
    { resolve: withNativeEnv(env, stdlibResolver()!), env, entryPoints: entries },
  )

  if (!built.ok) {
    ok(`the program builds for ${env}`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    return undefined
  }

  return nativePrelude(built.program, env, readFolded)
}

const mods = (prelude: string): number => (prelude.match(/^mod json \{/gm) ?? []).length

const alone = preludeOf(docked, ['shown'], 'rust')

if (alone !== undefined) {
  ok('a dock of <global:JSON> alone takes no shim', mods(alone) === 0, `${mods(alone)} mod json`)
}

const beside = preludeOf(both, ['both'], 'rust')

if (beside !== undefined) {
  ok('beside the stdlib json, the prelude holds mod json once', mods(beside) === 1, `${mods(beside)} mod json`)
}

// a capital-free dock still takes its shim, read folded or not
const plain = preludeOf(
  `load @term/base/json\n  find from-number\n  find stringify\n\ntask one\n  take n, like number\n  like text\n  send back\n    call stringify\n      call from-number\n        read n\n`,
  ['one'],
  'rust',
)

if (plain !== undefined) {
  ok('the stdlib json alone takes its shim', mods(plain) === 1, `${mods(plain)} mod json`)
}

console.log(`\nrust-prelude-case: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
