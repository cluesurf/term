// The Term-side data package (`@term/host`) against the compiler's reader: every fixture read by the package writes
// back the fixture byte for byte, packs to the compact fixture, converts to the JSON fixture, and JSON reads back
// to the long form. The compiler path (compile/host.ts) is the oracle. Compiles a probe entry that links the
// stdlib and the package, runs the emitted module. Run: npx tsx test/compile/host-term.ts

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import { readDataText, expandData, readStream, toJson, writeLong, writeCompact } from '@term/make/code/compile/host'

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
const FIXTURE = join(TERM, 'deck/host/test/fixture')

const ENTRY = `load @term/host/code/base
  find data
  find read
  find read-raw
  find write
  find pack
  find to-json
  find from-json
  find fill
  find melt
  find get-at
  find to-hash
  find read-lines
  find write-lines
  find make-reader
  find feed

load @term/seed/code/hash
  find keys

task round-long
  take input, like text
  like text
  send back
    call write(call read(read input))

task round-pack
  take input, like text
  like text
  send back
    call pack(call read(read input))

task round-json
  take input, like text
  like text
  send back
    call to-json(call read(read input))

task from-json-long
  take input, like text
  like text
  send back
    call write(call from-json(read input))

task keep-trees
  take input, like text
  like text
  save file
    call read-raw(read input)
  send back
    call write(read file/root, read file/trees)

task pack-trees
  take input, like text
  like text
  save file
    call read-raw(read input)
  send back
    call pack(read file/root, read file/trees)

task probe-fill
  take input, like text
  take shape, like text
  like dynamic
  send back
    call fill(call read(read input), call read(read shape))

task probe-melt
  take value, like dynamic
  like text
  send back
    call write(call melt(read value))

task probe-get
  take input, like text
  take path, like text
  like text
  save found
    call get-at(call read(read input), read path)
  fork case, read found
    case none
      send back, text <none>
    case some
      link value
      send back
        call write(read value)

task probe-keys
  take input, like text
  like list
  send back
    call keys(call to-hash(call read(read input)))

task probe-lines
  take input, like text
  like text
  send back
    call write(call read-lines(read input))

task probe-emit
  take input, like text
  like text
  save file
    call read-raw(read input)
  send back
    call write-lines(read file/root, read file/trees)

task probe-feed
  take first, like text
  take second, like text
  like text
  save reader
    call make-reader
  call feed(read reader, read first)
  call feed(read reader, read second)
  send back, read reader/hold
`

async function main(): Promise<void> {
  // a scratch project that links the stdlib and the package
  const root = mkdtempSync(join(tmpdir(), 'term-host-'))
  mkdirSync(join(root, 'link/@term'), { recursive: true })
  mkdirSync(join(root, 'code'), { recursive: true })
  symlinkSync(join(TERM, 'deck/seed'), join(root, 'link/@term/seed'))
  symlinkSync(join(TERM, 'deck/host'), join(root, 'link/@term/host'))
  writeFileSync(join(root, 'deck.tree'), 'deck @probe/host\n  code <0.0.0>\n')
  const entry = join(root, 'code/data.tree')
  writeFileSync(entry, ENTRY)

  const result = compile(
    { file: entry, text: ENTRY },
    { resolve: withNativeEnv('node', projectResolver(root)), deckOf: projectDeckOf() },
  )
  ok(
    'the package compiles',
    result.ok,
    result.ok ? '' : result.diagnostics.map(d => `${d.file?.split('/').pop()}: ${d.message}`).join(' | '),
  )

  if (!result.ok) {
    console.log(`\nhost-term: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  // the `<global:X>` runtime shims the program docks (json, here), prepended the way `term boot` does
  const prelude = nativePrelude(result.program, 'node', p =>
    existsSync(p) ? readFileSync(p, 'utf8') : undefined,
  )
  writeFileSync('/private/tmp/claude-501/-Users-lancepollard-base-crew-cluesurf/2f433557-455a-4061-b369-c0a2d2bac75e/scratchpad/host-term-emit.ts', result.typescript)
  const out = join(root, 'data.mjs')
  writeFileSync(
    out,
    transformSync(prelude + '\n' + result.typescript, { loader: 'ts', format: 'esm' }).code,
  )
  const mod = await import(pathToFileURL(out).href)

  const fixture = (name: string): string => readFileSync(join(FIXTURE, name), 'utf8')

  for (const name of ['basic', 'anchors']) {
    const long = fixture(`${name}.tree`)
    const line = fixture(`${name}.line`)

    // the oracle
    const read = readDataText({ file: name, text: long })

    if (!read.ok) {
      ok(`${name}: the oracle reads`, false)
      continue
    }

    const expanded = expandData(read.data, name)

    if (!expanded.ok) {
      ok(`${name}: the oracle expands`, false)
      continue
    }

    let got: string

    try {
      got = mod.roundLong(long)
      ok(`${name}: long reads and writes back like the oracle`, got === writeLong(expanded.data), got)
      got = mod.roundLong(line)
      ok(`${name}: compact reads to the same long form`, got === writeLong(expanded.data), got)
      got = mod.roundPack(long)
      ok(`${name}: packs like the oracle`, got === writeCompact(expanded.data), got)
      got = mod.roundJson(long)
      ok(`${name}: JSON like the oracle`, got === toJson(expanded.data), got)
      got = mod.fromJsonLong(toJson(expanded.data))
      ok(`${name}: JSON reads back to the long form`, got === writeLong(expanded.data), got)
      got = mod.keepTrees(long)
      ok(`${name}: anchors kept write back the fixture`, got === long, got)
      got = mod.packTrees(long)
      ok(`${name}: anchors kept pack to the fixture`, got === line, got)
    } catch (error) {
      const e = error as { link?: { rule?: string; line?: number } }
      ok(`${name}: the package runs`, false, `${String(error)} ${e.link?.rule ?? ''} line ${e.link?.line ?? '?'} ${((error as Error).stack ?? '').split('\n').slice(1, 3).join(' ')}`)
    }
  }

  // every scalar spelling, with the escapes, against the oracle
  const scalars = 'host a, -3.5\nhost b, true\nhost c, void\nhost d, <a \\<b\\> {c} \\{d\\} \\n\\t x>\nhost e, 0x1f\nhost f, 2.0\nhost <My Key>, 1\n'
  const oracleScalars = readDataText({ file: 's.tree', text: scalars })
  ok(
    'scalars and escapes write like the oracle',
    oracleScalars.ok && mod.roundLong(scalars) === writeLong(oracleScalars.data.root),
    `package: ${JSON.stringify(mod.roundLong(scalars))}\n      oracle:  ${JSON.stringify(oracleScalars.ok ? writeLong(oracleScalars.data.root) : '')}`,
  )
  ok(
    'scalars and escapes pack like the oracle',
    oracleScalars.ok && mod.roundPack(scalars) === writeCompact(oracleScalars.data.root),
    `package: ${JSON.stringify(mod.roundPack(scalars))}`,
  )
  ok(
    'scalars and escapes read back from the compact form',
    oracleScalars.ok && mod.roundLong(mod.roundPack(scalars)) === writeLong(oracleScalars.data.root),
    `package: ${JSON.stringify(mod.roundLong(mod.roundPack(scalars)))}`,
  )

  // fill, melt, paths, hashes, streams
  const shape = 'host x\n  host y\n    host z, <number>\n  host w, <text>\n  list a\n    <number>\n  list member\n    mesh\n      host name, <text>\n'
  const basicLong = fixture('basic.tree')

  try {
    const filled = mod.probeFill(basicLong, shape)
    ok('fill gives the value with its keys as written', JSON.stringify(filled) === JSON.stringify({ x: { y: { z: 123 }, w: 'foo', a: [5, 6, 7], member: [{ name: 'foo' }, { name: 'bar' }] } }), JSON.stringify(filled))
    ok('melt takes it back', mod.probeMelt(filled) === basicLong, mod.probeMelt(filled))
    ok('an optional key may be absent', JSON.stringify(mod.probeFill('host a, 1\n', 'host a, <number>\nhost b, <text?>\n')) === '{"a":1}')
    ok('a number fits a decimal', JSON.stringify(mod.probeFill('host a, 1\n', 'host a, <decimal>\n')) === '{"a":1}')
    ok('any fits anything', JSON.stringify(mod.probeFill('host a\n  host b, 1\n', 'host a, <any>\n')) === '{"a":{"b":1}}')
    ok('an empty list shape takes any list', JSON.stringify(mod.probeFill('list a\n  1, <x>\n', 'list a\n')) === '{"a":[1,"x"]}')
  } catch (error) {
    const e = error as { form?: string; form_?: string; reason?: string }
    ok('fill runs', false, `${String(error)} ${JSON.stringify(e)}`)
  }

  for (const [input, badShape, want] of [
    ['host a, <x>\n', 'host a, <number>\n', 'a is text where number belongs'],
    ['host a, 1\n', 'host a, <number>\nhost b, <text>\n', 'b is missing'],
    ['host a, 1\nhost c, 2\n', 'host a, <number>\n', 'c is not in the shape'],
    ['host a\n  list b\n    1, <x>\n', 'host a\n  list b\n    <number>\n', 'a/b/1 is text where number belongs'],
    ['host a, 1\n', 'host a\n  host b, <number>\n', 'a is a scalar where a map belongs'],
  ] as const) {
    try {
      mod.probeFill(input, badShape)
      ok(`fill refuses: ${want}`, false, 'accepted')
    } catch (error) {
      const e = error as { note?: string; link?: { path?: string; reason?: string } }
      const said = `${e.link?.path} ${e.link?.reason}`
      ok(`fill refuses: ${want}`, e.note === 'Data does not fit the shape' && said === want, `${e.note}: ${said}`)
    }
  }

  ok('get-at follows keys and indexes', mod.probeGet(basicLong, 'x/member/1/name') === '<bar>\n', mod.probeGet(basicLong, 'x/member/1/name'))
  ok('get-at reaches a list item', mod.probeGet(basicLong, 'x/a/2') === '7\n')
  ok('get-at gives none for a missing key', mod.probeGet(basicLong, 'x/nope') === 'none')
  ok('get-at gives none past the end', mod.probeGet(basicLong, 'x/a/9') === 'none')
  ok('get-at gives none for a word index', mod.probeGet(basicLong, 'x/a/first') === 'none')
  ok('to-hash keys a map by name', JSON.stringify([...mod.probeKeys('host b, 1\nhost a, 2\n')].sort()) === '["a","b"]', JSON.stringify(mod.probeKeys('host b, 1\nhost a, 2\n')))

  const streamText = fixture('stream.line')
  const oracle = readStream({ file: 'stream.line', text: streamText })
  ok('read-lines reads the stream like the oracle', oracle.ok && mod.probeLines(streamText) === writeLong(oracle.data), mod.probeLines(streamText))
  ok('a later anchor replaces the earlier one', mod.probeLines('t(a,h(x,1))\nh(p,f(a))\nt(a,h(x,2))\nh(q,f(a))\n') === 'host p\n  host x, 1\nhost q\n  host x, 2\n', mod.probeLines('t(a,h(x,1))\nh(p,f(a))\nt(a,h(x,2))\nh(q,f(a))\n'))
  ok('a stream of items is a list', mod.probeLines('m(h(name,<foo>))\n\n# note\nm(h(name,<bar>))\n') === 'mesh\n  host name, <foo>\nmesh\n  host name, <bar>\n')
  ok('write-lines emits the anchors a value needs, then the value', mod.probeEmit(fixture('anchors.tree')) === fixture('anchors.line'), mod.probeEmit(fixture('anchors.tree')))
  ok('write-lines skips an anchor nothing fuses', mod.probeEmit('tree unused\n  host a, 1\n\nhost b, 2\n') === 'h(b,2)\n', mod.probeEmit('tree unused\n  host a, 1\n\nhost b, 2\n'))
  ok('a reader knows what its stream is', mod.probeFeed('t(a)', 'm(h(x,1))') === 'list')

  try {
    mod.probeFeed('h(p,1)', 'm(h(x,2))')
    ok('a reader refuses a mixed stream', false, 'accepted')
  } catch (error) {
    const e = error as { form?: string; link?: { rule?: string; line?: number } }
    ok(
      'a reader refuses a mixed stream at its line',
      e.form === 'data-defect' && e.link?.line === 2,
      `${e.form} ${e.link?.rule} ${e.link?.line}`,
    )
  }

  // every bad fixture raises data-defect
  const bad = join(FIXTURE, 'bad')

  // draft.tree shelves the directory from `term make`; it is the one file there that is not a bad fixture
  for (const name of readdirSync(bad).filter(n => n !== 'draft.tree').sort()) {
    const text = fixture(join('bad', name))
    const want = text.split('\n')[0]!.replace(/^# /, '')

    try {
      mod.roundLong(text)
      ok(`bad/${name} is refused`, false, 'accepted')
    } catch (error) {
      const e = error as { form?: string; link?: { rule?: string } }
      ok(`bad/${name} is refused`, e.form === 'data-defect', `${e.form}: ${e.link?.rule ?? String(error)}`)
      // the same words as the compiler's reader, so a person sees one message whichever path read the file
      ok(`bad/${name} says what the compiler says`, e.link?.rule === want, `package: ${e.link?.rule}\n      compiler: ${want}`)
    }
  }

  console.log(`\nhost-term: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
