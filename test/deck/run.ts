// Tests for the load resolver: classification, file resolution with fallback, package parsing, deck-root walk,
// and store paths. Run: npx tsx test/deck/run.ts

import {
  classifyLoad,
  findDeckRoot,
  parsePackage,
  resolveLoad,
  storePath,
} from '@cluesurf/make/code/deck/resolve'

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${g}, want ${w})`)
  }
}

function main(): void {
  // classification
  expect('classify relative', classifyLoad('./foo'), 'relative')
  expect('classify absolute', classifyLoad('/foo/bar'), 'absolute')
  expect('classify package', classifyLoad('@termsurf/wolf'), 'package')
  expect('classify glob', classifyLoad('**/*.tree'), 'glob')
  expect('classify native', classifyLoad('<node:fs>', true), 'native')

  // an in-memory file system
  const files = new Set<string>([
    '/proj/deck.tree',
    '/proj/code/base.tree',
    '/proj/code/helper.tree',
    '/proj/code/widget/base.tree',
  ])
  const exists = (p: string): boolean => files.has(p)

  // file resolution with extension fallback
  expect(
    'resolve sibling .tree',
    resolveLoad('./helper', '/proj/code/base.tree', exists),
    { kind: 'file', path: '/proj/code/helper.tree' },
  )
  expect(
    'resolve dir to base.tree',
    resolveLoad('./widget', '/proj/code/base.tree', exists),
    { kind: 'file', path: '/proj/code/widget/base.tree' },
  )
  expect(
    'resolve missing',
    resolveLoad('./nope', '/proj/code/base.tree', exists),
    { kind: 'missing', target: './nope' },
  )

  // package parsing
  expect('parse scoped package', parsePackage('@termsurf/wolf'), {
    host: 'termsurf',
    name: 'wolf',
    subpath: undefined,
  })
  expect(
    'parse scoped with subpath',
    parsePackage('@termsurf/wolf/code/tool'),
    { host: 'termsurf', name: 'wolf', subpath: 'code/tool' },
  )
  expect(
    'resolve package load',
    resolveLoad('@termsurf/wolf/code', '/proj/code/base.tree', exists),
    {
      kind: 'package',
      host: 'termsurf',
      name: 'wolf',
      subpath: 'code',
    },
  )

  // native module
  expect(
    'resolve native',
    resolveLoad('<node:fs>', '/proj/code/base.tree', exists, true),
    { kind: 'native', module: 'node:fs' },
  )

  // deck-root walk-up
  expect(
    'find deck root',
    findDeckRoot('/proj/code/widget/base.tree', exists),
    '/proj',
  )
  expect(
    'no deck root',
    findDeckRoot('/other/x.tree', exists),
    undefined,
  )

  // store path layout
  expect(
    'store path',
    storePath('/home/me', 'termsurf', 'wolf', '0.0.1'),
    '/home/me/.seed/deck/link/termsurf/wolf/0.0.1',
  )

  console.log(`\ndeck: ${pass} pass, ${fail} fail`)
}

main()
