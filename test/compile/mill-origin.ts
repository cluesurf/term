// A UNIT'S STORED BYTES DO NOT HANG ON WHERE ITS MILL CAME FROM (item term-self-host-001-0432, decision 077 section 4).
// A pool build mills a module in one worker and reads that mill back from the store in another. The mill wrote keys
// holding nothing (`result` on a task with no `like`) and shared type objects between nodes, which the store's JSON
// drops; a pass that later writes such a key put it in its milled place on a fresh mill and at the end on a stored one,
// so the unit answer stored differed by the process that built it, and TERM_CACHE_VERIFY=hits stopped a clean pool
// build of deck/zone. Here one project builds on two stores: A mills every module fresh, B starts with A's mill entries
// only. Every unit entry both write under one key must hold the same bytes, and a milled module must hold no key whose
// value is undefined.
// Run: npx tsx test/compile/mill-origin.ts

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { gunzipSync } from 'node:zlib'
import {
  buildSession,
  compileProjectSeparate,
} from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'
import { milledModule } from '@term/make/code/compile/compile'
import { makeParseMemo } from '@term/make/code/compile/load'

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

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mill-origin-')))

// a task with no `like` (write-file) is the one whose `result` the checker writes
const project = (name: string): string => {
  const root = join(dir, name)
  mkdirSync(join(root, 'code'), { recursive: true })
  writeFileSync(
    join(root, 'deck.tree'),
    `deck @probe/mill-origin\n  mark <0.0.1>\n`,
  )
  writeFileSync(
    join(root, 'code', 'base.tree'),
    `load @term/base/native/node/file\n  find write-file\n\ntask main\n  mark async\n  call write-file\n    text <a>\n    text <b>\n`,
  )
  return root
}

const entries = (at: string): string[] =>
  existsSync(at)
    ? readdirSync(at).flatMap(name => {
        const full = join(at, name)
        return statSync(full).isDirectory() ? entries(full) : [full]
      })
    : []

const read = (file: string): string => {
  const raw = readFileSync(file)
  return raw[0] === 0x1f
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8')
}

const build = (root: string, store: string) =>
  compileProjectSeparate(
    root,
    new CompileCache(
      diskCacheStore(store, 'mill-origin'),
      'mill-origin',
    ),
    'node',
    buildSession(root),
  )

// a milled module is its stored form: no key holds undefined
const undefinedKeys = (
  value: unknown,
  at: string,
  out: string[],
): void => {
  if (value === null || typeof value !== 'object') return
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) out.push(`${at}.${key}`)
    else undefinedKeys(inner, `${at}.${key}`, out)
  }
}
const file = realpathSync(
  join(
    import.meta.dirname,
    '../../deck/base/code/native/node/file.tree',
  ),
)
const milled = milledModule(
  { file, text: readFileSync(file, 'utf8') },
  {
    parsed: makeParseMemo(),
    templates: new Map(),
    templateKey: '',
    lean: false,
  },
)
const holes: string[] = []
undefinedKeys(milled, '', holes)
ok(
  'a milled module holds no key whose value is undefined',
  holes.length === 0,
  holes.slice(0, 4).join(' '),
)

const [storeA, storeB] = [join(dir, 'store-a'), join(dir, 'store-b')]
const a = build(project('a'), storeA)
ok(
  'the build on a fresh mill builds',
  a.failed === 0,
  a.errors.join(' | '),
)
const mills = entries(storeA).filter(f =>
  relative(storeA, f).startsWith('mill'),
)
ok('and stores its mills', mills.length > 0)
for (const f of mills) {
  const to = join(storeB, relative(storeA, f))
  mkdirSync(join(to, '..'), { recursive: true })
  cpSync(f, to)
}
const b = build(project('b'), storeB)
ok(
  'the build on stored mills builds',
  b.failed === 0,
  b.errors.join(' | '),
)

let same = 0
const differ: string[] = []
for (const f of entries(storeA).filter(f =>
  relative(storeA, f).startsWith('unit'),
)) {
  const g = join(storeB, relative(storeA, f))
  if (!existsSync(g)) continue
  const [x, y] = [read(f), read(g)]
  if (x === y) {
    same++
    continue
  }
  let at = 0
  while (x[at] === y[at]) at++
  differ.push(
    `${relative(storeA, f)} at ${at}: ${x.slice(at - 60, at + 40)} against ${y.slice(at - 60, at + 40)}`,
  )
}
ok(
  'the stdlib units both stores hold are compared',
  same + differ.length > 0,
)
ok(
  'every unit both stores hold has the same bytes',
  differ.length === 0,
  differ.join('\n'),
)

rmSync(dir, { recursive: true, force: true })
console.log(`\nmill-origin: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
