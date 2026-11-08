// Decision 136 of term/self-host/change/001-finish-self-host: a `need false` maybe field handed to a `like dynamic`
// parameter of a bind is the warning `maybe-to-dynamic`, naming the field and the bind. D10 reads the field as a Term
// maybe on every backend, so the bind's host code gets the maybe and a host `??` over it never falls back (trap T-0947,
// the 1074 case). The meaning stays D10's (test/compile/maybe-field.ts). Held here:
//   - the 1074 case warns once, at the call, naming `gap/span` and `value-or`
//   - a maybe read first with a `sift`, a bind whose parameter is typed, a maybe field that is not `need false`, and a
//     `need false` field that is not a maybe are not warned about
//   - the warning is a warning: the build still succeeds
// Run: npx tsx test/check/maybe-to-dynamic.ts

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

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

const head = `load @term/base/maybe
  find maybe

form spot
  link line, like number

form gap
  link form, like text
  link span
    like maybe, like spot
    need false
  link kept
    like maybe, like spot
  link count
    like number
    need false

bind value-or
  take value, like dynamic
  take fallback, like dynamic
  like dynamic
  case node
    text <($value ?? $fallback)>
  case browser
    text <($value ?? $fallback)>
  case rust
    text <$value>
  case swift
    text <$value>
  case kotlin
    text <$value>

bind spot-or
  take value, like maybe, like spot
  take fallback, like dynamic
  like dynamic
  case node
    text <($value ?? $fallback)>
  case browser
    text <($value ?? $fallback)>
  case rust
    text <$value>
  case swift
    text <$value>
  case kotlin
    text <$value>

task no-spot
  like spot

  back
    make spot
      bind line, 0
`

type Built = {
  ok: boolean
  warnings?: { name: string; message: string }[]
  diagnostics?: { message: string }[]
}

function build(body: string): Built {
  return compile({ file: 'maybe-to-dynamic.tree', text: `${head}\n${body}` }, {
    resolve: withNativeEnv('node', stdlibResolver()!),
    library: true,
    leanOf: () => true,
  } as never) as Built
}

function said(built: Built): { name: string; message: string }[] {
  return (built.warnings ?? []).filter(w => w.name === 'maybe-to-dynamic')
}

function failure(built: Built): string {
  return (built.diagnostics ?? []).map(d => d.message.split('\n').join(' ')).join(' | ')
}

// the 1074 case (tmp/self-host/1074/case/maybe-host.tree)
const flagged = build(`task span-or
  take value, like gap
  like dynamic

  back value-or(value/span, no-spot())
`)
ok('the 1074 case builds', flagged.ok, failure(flagged))
const flaggedSaid = said(flagged)
ok(
  'the 1074 case warns once',
  flaggedSaid.length === 1,
  (flagged.warnings ?? []).map(w => `${w.name}: ${w.message}`).join(' | '),
)
ok(
  'the warning names the field and the bind',
  flaggedSaid.length === 1 && flaggedSaid[0]!.message.includes('gap/span') && flaggedSaid[0]!.message.includes('value-or'),
  flaggedSaid[0]?.message ?? '',
)

const sifted = build(`task span-or
  take value, like gap
  like dynamic

  sift value/span
    case some
      link found
      back value-or(found, no-spot())
    case none
      back no-spot()
`)
ok('a maybe read with a sift first is not warned about', sifted.ok && said(sifted).length === 0, failure(sifted))

const typed = build(`task span-or
  take value, like gap
  like dynamic

  back spot-or(value/span, no-spot())
`)
ok('a bind whose parameter is typed is not warned about', typed.ok && said(typed).length === 0, failure(typed))

const kept = build(`task kept-or
  take value, like gap
  like dynamic

  back value-or(value/kept, no-spot())
`)
ok('a maybe field that is not need false is not warned about', kept.ok && said(kept).length === 0, failure(kept))

const counted = build(`task count-or
  take value, like gap
  like dynamic

  back value-or(value/count, 0)
`)
ok('a need false field that is not a maybe is not warned about', counted.ok && said(counted).length === 0, failure(counted))

console.log(`\nmaybe-to-dynamic: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  process.exit(1)
}
