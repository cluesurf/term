// Exceptions: a form that is `like exception`, `halt <form>` with binds, pins, fallbacks, named type arguments, and
// the emitted TypeScript throwing the runtime class. Run: npx tsx test/compile/exception.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'

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

// a minimal stand-in for the stdlib `exception` module, so the test needs no resolver
const STDLIB = `form exception
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
    link limit, like number, need false
    link actual, like number, fall 0
`

function build(text: string) {
  return compile({ file: 'x.tree', text: `${STDLIB}\n${text}` })
}

function messages(result: ReturnType<typeof compile>): string {
  return result.ok
    ? ''
    : result.diagnostics.map(d => d.message ?? d.name).join(' | ')
}

async function main(): Promise<void> {
  // a raise of a stdlib exception, with a prop that falls back
  const RAISE = `task store
  take size, like number
  like number
  halt excess
    bind thing, text <upload>
    bind limit, code 5
  send back, read size
`
  const raised = build(RAISE)
  ok('a halt of an exception compiles', raised.ok, messages(raised))

  const ts = raised.ok ? raised.typescript : ''
  ok('the raise throws the runtime class', ts.includes('throw new TermException('))
  ok('the class is emitted once', ts.split('class TermException').length === 2)
  ok('host is filled', ts.includes('host: "@local"'))
  ok('form is filled', ts.includes('form: "excess"'))
  ok('the note is pinned in', ts.includes('note: "Too large"'))
  ok('the occurrence is a call', ts.includes('code: exceptionCode()'))
  ok('the props sit under link', /link: \{ thing: "upload", limit: 5, actual: 0 \}/.test(ts))

  // run it: the thrown value is an Error with the fields
  if (raised.ok) {
    const dir = mkdtempSync(join(tmpdir(), 'term-exception-'))
    const file = join(dir, 'x.mjs')
    writeFileSync(
      file,
      transformSync(raised.typescript, { loader: 'ts', format: 'esm' }).code,
    )

    try {
      const mod = await import(pathToFileURL(file).href)

      try {
        mod.store(9)
        ok('the raise throws', false, 'nothing thrown')
      } catch (e) {
        const err = e as { form?: string; note?: string; link?: { limit?: number; actual?: number } }
        ok('the thrown value is an Error', e instanceof Error)
        ok('it carries form', err.form === 'excess')
        ok('it carries the pinned note', err.note === 'Too large')
        ok('it carries the props', err.link?.limit === 5 && err.link?.actual === 0)
      }
    } catch (e) {
      ok('the emitted module loads', false, String(e))
    }
  }

  // a more specific exception, like excess, pinning thing and adding a prop
  const DERIVED = `form upload-excess
  like excess
    bind note, <Upload too large>
    bind thing, <upload>
    link policy, like text

task store
  like number
  halt upload-excess
    bind limit, code 5
    bind policy, text <avatar>
  send back, code 1
`
  const derived = build(DERIVED)
  ok('a derived exception compiles', derived.ok, messages(derived))
  const dts = derived.ok ? derived.typescript : ''
  ok('the derived note wins', dts.includes('note: "Upload too large"'))
  ok('the pinned thing is filled', dts.includes('thing: "upload"'))
  ok('the added prop is carried', dts.includes('policy: "avatar"'))
  ok('the derived props record is synthesized', dts.includes('interface UploadExcessLink'))

  // refusals
  const PINNED = `task store
  halt excess
    bind thing, text <upload>
    bind note, text <no>
`
  ok('giving a pinned field is refused', !build(PINNED).ok && messages(build(PINNED)).includes('pinned'))

  const UNKNOWN = `task store
  halt excess
    bind thing, text <upload>
    bind size, code 1
`
  ok('an unknown prop is refused', !build(UNKNOWN).ok && messages(build(UNKNOWN)).includes('no prop "size"'))

  const MISSING = `task store
  halt excess
    bind limit, code 5
`
  ok('a missing required prop is refused', !build(MISSING).ok && messages(build(MISSING)).includes('needs "thing"'))

  const NOT_EXCEPTION = `form point
  link x, like number

task store
  halt point
    bind x, code 1
`
  ok('raising a plain form is refused', !build(NOT_EXCEPTION).ok && messages(build(NOT_EXCEPTION)).includes('not an exception'))

  const NO_NOTE = `form quiet
  like exception
    link thing, like text
`
  ok('an exception without a note is refused', !build(NO_NOTE).ok && messages(build(NO_NOTE)).includes('pin its note'))

  // named type arguments on a form with several parameters
  const NAMED = `form foo
  head a
  head b
  link note, like text
  link left, like a
  link right, like b

form example
  like foo
    head a
      link x, like text
    head b, like number
    bind note, <Example>

task use
  like example
  send back
    make example
      bind left
        make example-left
          bind x, text <hi>
      bind right, code 3
`
  const named = build(NAMED)
  ok('named type arguments compile', named.ok, messages(named))
  const nts = named.ok ? named.typescript : ''
  ok('the anonymous record is named after the field it types', nts.includes('interface ExampleLeft'))
  ok('the pin is added at construction', nts.includes('note: "Example"'))

  const AMBIGUOUS = `form foo
  head a
  head b
  link left, like a
  link right, like b

form example
  like foo
    link x, like text
`
  ok('a bare link under a two-parameter base is refused', !build(AMBIGUOUS).ok && messages(build(AMBIGUOUS)).includes('takes 2 type parameters'))

  console.log(`\nexception: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
