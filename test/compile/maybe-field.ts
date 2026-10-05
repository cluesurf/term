// D10 (decided 2026-10-05): a `need false` field typed `maybe T` is `f?: T` on TypeScript and `maybe T` everywhere
// else. Held here on TypeScript, end to end with TypeScript callers on the other side of the boundary:
//   - the emitted type is `hint?: string`, the shape a TypeScript caller writes, not `hint?: Maybe<string>`
//   - Term code READS it as a maybe: `some` with the value where the caller set it, `none` where the caller left it out
//   - a construction WRITES the value inside the maybe, and leaves the field out for none
//   - an assignment writes the same way, and a case arm binds the field as a maybe
// A plain `need false` field (`count`) keeps its empty value. Run: npx tsx test/compile/maybe-field.ts

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

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const text = `load @term/base/maybe
  find maybe

form note
  link body, like text
  link hint
    like maybe, like text
    need false
  link count
    like number
    need false

form shape
  case mark
    link label
      like maybe, like text
      need false

task hint-of
  take value, like note
  like text

  sift value/hint
    case some
      link written
      back written
    case none
      back <none>

task count-of
  take value, like note
  like number

  back value/count

task with-hint
  take written, like text
  like note

  back
    make note
      bind body, <b>
      bind hint, make some(written)

task without-hint
  like note

  back
    make note
      bind body, <b>

task set-hint
  take value, like note
  take written, like text
  like note

  save value/hint, make some(written)
  back value

task label-of
  take value, like shape
  like text

  sift value
    case mark
      sift label
        case some
          link written
          back written
        case none
          back <unlabelled>
`

const built = compile({ file: 'maybe-field.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
} else {
  const ts = built.typescript
  ok('the emitted field is the value type, optional', /hint\?: string\b/.test(ts) && /label\?: string\b/.test(ts), ts.split('\n').filter(l => /hint|label/.test(l) && /:/.test(l)).slice(0, 4).join(' | '))
  ok('no field is typed as a Maybe', !/hint\?: Maybe|label\?: Maybe/.test(ts))

  const dir = mkdtempSync(join(tmpdir(), 'term-maybe-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(ts, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => any>

  // a TypeScript caller's records, written the TypeScript way
  ok('a caller that set the field is read as some', mod.hintOf!({ body: 'b', hint: 'look' }) === 'look')
  ok('a caller that left it out is read as none', mod.hintOf!({ body: 'b' }) === 'none')
  ok('a plain need false field left out is its empty value, as it is natively', mod.countOf!({ body: 'b' }) === 0, String(mod.countOf!({ body: 'b' })))

  const made = mod.withHint!('here')
  ok('a construction writes the value inside the maybe', made.hint === 'here', JSON.stringify(made))
  const bare = mod.withoutHint!()
  ok('and leaves the field absent for none', bare.hint === undefined, JSON.stringify(bare))
  const set = mod.setHint!({ body: 'b' }, 'later')
  ok('an assignment writes the value inside the maybe', set.hint === 'later', JSON.stringify(set))
  ok('a case arm binds the field as a maybe', mod.labelOf!({ form: 'mark', label: 'x' }) === 'x' && mod.labelOf!({ form: 'mark' }) === 'unlabelled')
}

console.log(`\nmaybe-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
