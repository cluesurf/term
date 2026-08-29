// Term data (the host dialect): every fixture reads, writes back byte for byte in both spellings, converts to its
// JSON fixture and back; every bad fixture gives its message; anchors expand and a cycle is refused.
// Run: npx tsx test/compile/host.ts

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  expandData,
  fromJson,
  isDataFile,
  readDataText,
  toJson,
  writeCompact,
  writeLong,
} from '@term/make/code/compile/host'

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

const FIXTURE = join(
  import.meta.dirname ?? new URL('.', import.meta.url).pathname,
  '../../deck/host/test/fixture',
)

function fixture(name: string): string {
  return readFileSync(join(FIXTURE, name), 'utf8')
}

function read(file: string, text: string) {
  const result = readDataText({ file, text })

  if (!result.ok) {
    throw new Error(result.diagnostics.map(d => d.message).join(' | '))
  }

  return result.data
}

function main(): void {
  // recognition
  ok('the long form is recognised as data', isDataFile({ file: 'b.tree', text: fixture('basic.tree') }))
  ok('the compact form is recognised as data', isDataFile({ file: 'b.line', text: fixture('basic.line') }))
  ok(
    'a code file of constants is not data',
    !isDataFile({ file: 'c.tree', text: 'host x, code 10\nhost y, text <a>\n' }),
  )
  ok('a task is not data', !isDataFile({ file: 'c.tree', text: 'task go\n  send back, code 1\n' }))

  // the basic example: long and compact read to the same value
  const long = read('basic.tree', fixture('basic.tree'))
  const compact = read('basic.line', fixture('basic.line'))
  ok('long and compact read to one value', JSON.stringify(long.root) === JSON.stringify(compact.root))

  // and write back byte for byte
  ok('the long writer is canonical', writeLong(long.root) === fixture('basic.tree'))
  ok('the compact writer is canonical', writeCompact(long.root) === fixture('basic.line'))

  // JSON both ways
  ok('to JSON matches the fixture', toJson(long.root) + '\n' === fixture('basic.json'))
  const back = fromJson(fixture('basic.json'))
  ok('from JSON reads back to the value', JSON.stringify(back) === JSON.stringify(long.root))

  // key case at the boundary
  const keyed = read('k.tree', 'host retry-after, 3\n')
  ok('a kebab key is snake in JSON', toJson(keyed.root) === '{"retry_after":3}')
  ok('and kebab again on the way back', writeLong(fromJson('{"retry_after":3}')) === 'host retry-after, 3\n')
  ok('keep leaves the key alone', toJson(keyed.root, true) === '{"retry-after":3}')

  // scalars
  const scalars = read(
    's.tree',
    'host a, -3.5\nhost b, true\nhost c, void\nhost d, <a \\<b\\> {c}>\nhost e, 0x1f\n',
  )
  ok('scalars read', toJson(scalars.root) === '{"a":-3.5,"b":true,"c":null,"d":"a <b> {c}","e":31}')

  // a text key from foreign JSON survives a round trip
  const foreign = fromJson('{"My Key":1}')
  ok('a foreign key is written as text', writeLong(foreign) === 'host <My Key>, 1\n')
  ok('and reads back', toJson(read('f.tree', writeLong(foreign)).root, true) === '{"My Key":1}')

  // anchors
  const anchors = read('anchors.tree', fixture('anchors.tree'))
  ok('the anchor is read', anchors.trees.has('service-config'))
  const expanded = expandData(anchors)
  ok('anchors expand', expanded.ok)

  if (expanded.ok) {
    const json = toJson(expanded.data)
    ok(
      'a fused map has the anchor entries',
      json.includes('"prod_service":{"config":{"env":"prod","retries":3,"version":6.8}}'),
    )
    ok(
      'a key after the fuse wins',
      json.includes('"dev_service":{"config":{"env":"prod","retries":3,"version":7.23}}'),
    )
  }

  ok('the anchor file writes back long', writeLong(anchors.root, anchors.trees) === fixture('anchors.tree'))
  ok(
    'the anchor file writes back compact',
    writeCompact(anchors.root, anchors.trees) === fixture('anchors.line'),
  )

  const cycle = read('c.tree', 'tree a\n  fuse b\ntree b\n  fuse a\nhost x\n  fuse a\n')
  const cycled = expandData(cycle)
  ok(
    'a cycle is refused',
    !cycled.ok && cycled.diagnostics.some(d => d.message.includes('fuses itself')),
  )

  // every bad fixture gives its message
  // draft.tree shelves the directory from `term make`; it is the one file there that is not a bad fixture
  for (const name of readdirSync(join(FIXTURE, 'bad')).filter(n => n !== 'draft.tree').sort()) {
    const text = fixture(join('bad', name))
    const want = text.split('\n')[0]!.replace(/^# /, '')
    const result = readDataText({ file: name, text })
    const got = result.ok
      ? (() => {
          const expanded = expandData(result.data, name)

          return expanded.ok ? '' : expanded.diagnostics.map(d => d.message).join(' | ')
        })()
      : result.diagnostics.map(d => d.message).join(' | ')

    ok(`bad/${name} says its message`, got.includes(want), `got: ${got || '(accepted)'}`)
  }

  // a stream: one form per line, anchors first
  const stream = read('stream.line', fixture('stream.line'))
  const streamed = expandData(stream)
  ok('a stream reads', streamed.ok && toJson(streamed.data).includes('"b":123456'))

  console.log(`\nhost: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
