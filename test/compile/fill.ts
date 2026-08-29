// `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: the compiler walks the form's fields,
// so a data value becomes a value of the form (members named the way the emitter names them) and a form value
// goes back to data. A value that does not fit raises `data-mismatch` from @term/host with the path and the
// reason, and the roll shows the task raising it. Run: npx tsx test/compile/fill.ts

import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'

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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

const ENTRY = `load @term/host/code/base
  find data
  find read
  find write

form limit
  link burst, like number
  link rate, like decimal

form service
  link name, like text
  link retry-after, like number
  link secure, like boolean
  link region, like text
    need false
  link limit, like limit
  link tags
    like list
      like text

task load
  take input, like text
  like service
  send back
    call fill
      call read(read input)
      like service

task save-service
  take value, like service
  like text
  send back
    call write
      call melt
        read value
        like service

task round-trip
  take input, like text
  like text
  send back
    call save-service(call load(read input))
`

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'term-fill-'))
  mkdirSync(join(root, 'link/@term'), { recursive: true })
  mkdirSync(join(root, 'code'), { recursive: true })
  symlinkSync(join(TERM, 'deck/seed'), join(root, 'link/@term/seed'))
  symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/fill\n  code <0.0.0>\n')
  const entry = join(root, 'code/fill.tree')
  writeFileSync(entry, ENTRY)

  const result = compile(
    { file: entry, text: ENTRY },
    { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf(), roll: true },
  )
  ok(
    'fill and melt with a form compile',
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => `${d.file?.split('/').pop()}: ${d.message}`).join(' | '),
  )

  if (!result.ok) {
    console.log(`\nfill: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  ok('the walk is emitted once, in the prelude', result.typescript.split('function __termFill(').length === 2)
  ok('the spec names the members the emitter uses', result.typescript.includes('"member":"retryAfter"'))
  const loadTask = (result.roll?.task ?? []).find(t => t.name === 'load') as { halt?: string[] } | undefined
  ok(
    'the roll shows load raising data-mismatch',
    Boolean(loadTask?.halt?.includes('data-mismatch')),
    JSON.stringify(loadTask ?? result.roll?.task?.slice(0, 3)),
  )

  const prelude = nativePrelude(result.program, 'node', p => (existsSync(p) ? readFileSync(p, 'utf8') : undefined))
  const out = join(root, 'fill.mjs')
  writeFileSync(out, transformSync(prelude + '\n' + result.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = await import(pathToFileURL(out).href)

  const good = 'host name, <api>\nhost retry-after, 3\nhost secure, true\nhost limit\n  host burst, 10\n  host rate, 2.5\nlist tags\n  <a>, <b>\n'
  const loaded = mod.load(good)
  ok('fill gives a value of the form', loaded.name === 'api' && loaded.retryAfter === 3 && loaded.secure === true, JSON.stringify(loaded))
  ok('a nested form fills', loaded.limit?.burst === 10 && loaded.limit?.rate === 2.5, JSON.stringify(loaded.limit))
  ok('a list of text fills', JSON.stringify(loaded.tags) === '["a","b"]', JSON.stringify(loaded.tags))
  ok('an optional field left out is absent', !('region' in loaded))
  ok('melt writes the value back as data', mod.roundTrip(good) === good, mod.roundTrip(good))

  const withRegion = good + 'host region, <eu>\n'
  ok('an optional field present is kept', mod.load(withRegion).region === 'eu')

  for (const [input, want] of [
    ['host name, <api>\n', 'retry-after is missing'],
    ['host name, 1\nhost retry-after, 3\nhost secure, true\nhost limit\n  host burst, 10\n  host rate, 2\nlist tags\n  <a>\n', 'name is number where text belongs'],
    [good + 'host extra, 1\n', 'extra is not in the form'],
    ['host name, <api>\nhost retry-after, 3\nhost secure, true\nhost limit, 5\nlist tags\n  <a>\n', 'limit is a scalar where a map belongs'],
    ['host name, <api>\nhost retry-after, 3\nhost secure, true\nhost limit\n  host burst, 10\n  host rate, 2\nlist tags\n  1\n', 'tags/0 is number where text belongs'],
  ] as const) {
    try {
      mod.load(input)
      ok(`fill refuses: ${want}`, false, 'accepted')
    } catch (error) {
      const e = error as { form?: string; host?: string; link?: { path?: string; reason?: string } }
      ok(
        `fill refuses: ${want}`,
        e.form === 'data-mismatch' && e.host === '@term/host' && `${e.link?.path} ${e.link?.reason}` === want,
        `${e.form} ${e.link?.path} ${e.link?.reason}`,
      )
    }
  }

  // a number fits a decimal field, a whole decimal melts back as a decimal
  const whole = 'host name, <api>\nhost retry-after, 3\nhost secure, false\nhost limit\n  host burst, 10\n  host rate, 2\nlist tags\n  <a>\n'
  ok('a number fits a decimal field', mod.load(whole).limit.rate === 2)
  ok('a whole decimal melts as a decimal', mod.roundTrip(whole).includes('host rate, 2.0'), JSON.stringify(mod.roundTrip(whole)))

  // without a `like`, `fill` is the package's runtime task and needs a shape
  const runtime = compile(
    { file: entry, text: ENTRY.replace('    call fill\n      call read(read input)\n      like service', '    call fill\n      call read(read input)') },
    { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf() },
  )
  ok('fill without a form is the runtime task', !runtime.ok && runtime.diagnostics.some(d => /shape|argument/.test(d.message)), runtime.ok ? 'compiled' : runtime.diagnostics.map(d => d.message).join(' | '))

  // a `like` that is not a form with fields is refused
  const bad = compile(
    { file: entry, text: ENTRY.replace('      like service\n\ntask save-service', '      like text\n\ntask save-service') },
    { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf() },
  )
  ok('fill needs a form after like', !bad.ok && bad.diagnostics.some(d => d.message.includes('needs a form')), bad.ok ? 'compiled' : bad.diagnostics.map(d => d.message).join(' | '))

  // the native backends generate a walker per form (test/compile/host-native.ts builds and runs them)
  const rust = emitRust(result.program)
  ok('rust generates a fill walker per form', rust.includes('fn __fill_service(') && rust.includes('fn __fill_limit('))
  ok('rust generates a melt walker per form', rust.includes('fn __melt_service(') && rust.includes('fn __melt_limit('))
  ok('rust refuses a field with no data form', (() => {
    const odd = compile(
      { file: entry, text: ENTRY.replace('  link tags\n    like list\n      like text\n', '  link tags\n    like list\n      like text\n  link extra, like dynamic\n') },
      { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf() },
    )

    if (!odd.ok) {
      return false
    }

    try {
      emitRust(odd.program)

      return false
    } catch (error) {
      return String(error).includes('no data form')
    }
  })())

  console.log(`\nfill: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
