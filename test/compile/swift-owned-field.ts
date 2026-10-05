// A list variable put into a field the record owns as a plain array (`fieldLists` in compile/swift.ts) goes in as an
// array, not as its `SeedList`. An async function owns no locals, so `host none, make list` there stayed a
// `SeedList<Int>` and was passed whole to a `[Int]` field: "cannot convert value of type 'SeedList<Int>' to expected
// argument type '[Int]'", found the first time deck/test/code/smt-query.tree's `check-sat` ran on Swift (2026-10-05).
// The field takes a plain local as it is and any other variable's `.data`.
//
// Whether a field is owned is a whole-program analysis (`ownedFields`, `privateForms`), which a small program does not
// reach, so this compiles the program that found it: @term/test's weakest-precondition, through its own resolver.
// Run: npx tsx test/compile/swift-owned-field.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf } from '@term/call/code/role-of'

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

const root = join(process.cwd(), 'deck', 'test')
const file = join(root, 'code', 'weakest-precondition.tree')
const built = compile(
  { file, text: readFileSync(file, 'utf8') },
  { resolve: withNativeEnv('swift', projectResolver(root)), env: 'swift', entryPoints: ['verify-procedure'], leanOf: projectLeanOf(root) } as never,
)

if (!built.ok) {
  ok('weakest-precondition builds for swift', false, built.diagnostics.slice(0, 3).map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const swift = emitSwift(built.program)
  const lines = swift.split('\n')
  const field = lines.find(l => /^\s+var values: /.test(l) && lines[lines.indexOf(l) - 2]?.includes('struct Verdict')) ?? ''
  const owned = /var values: \[Int\]/.test(field)

  ok('the program reaches the owned-field path (Verdict.values is a plain array)', owned, field.trim())

  if (owned) {
    const constructions = lines.filter(l => /Verdict\(status: .*values: none/.test(l))
    ok(
      'the async task\'s empty SeedList goes in as its data',
      constructions.length > 0 && constructions.every(l => /values: none\.data\)/.test(l)),
      constructions.map(l => l.trim()).join(' | '),
    )
  }
}

console.log(`\nswift-owned-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
