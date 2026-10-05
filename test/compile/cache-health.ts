// Cache health (note/term/plan/incremental-best-in-class.md, step 14). Every entry the build reads may be damaged: cut
// short by a full disk, garbage from a bad sector, or a well-formed file of the wrong shape. Each is a miss, the build
// is the same build, and the entry it writes afterwards is a good one. Here every entry of every kind a separate build
// stores (mill, scan, unit) is damaged in one of those three ways, and the project is built again from disk.
// Run: npx tsx test/compile/cache-health.ts

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import { buildSession, compileProjectSeparate } from '@term/call/code/make'
import { diskCacheStore } from '@term/call/code/cache-store'
import { CompileCache } from '@term/make/code/compile/cache'

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

const root = realpathSync(mkdtempSync(join(tmpdir(), 'cache-health-')))
const store = realpathSync(mkdtempSync(join(tmpdir(), 'cache-health-store-')))
mkdirSync(join(root, 'code'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/health\n  mark <0.0.1>\n`)
writeFileSync(join(root, 'code', 'helper.tree'), `load @term/base/text\n  find trim\n\ntask greet\n  take who, like text\n  like text\n  back trim(who)\n`)
writeFileSync(join(root, 'code', 'base.tree'), `load ./helper\n  find greet\n\ntask main\n  like text\n  back greet(< you >)\n`)

const build = () => compileProjectSeparate(root, new CompileCache(diskCacheStore(store, 'health'), 'health'), 'node', buildSession(root))

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap(name => {
    const full = join(dir, name)

    return statSync(full).isDirectory() ? files(full) : full.endsWith('.json.gz') ? [full] : []
  })

// every module the build emitted, in name order
const artifacts = (): string =>
  readdirSync(join(root, 'host', '.unit'))
    .sort()
    .map(name => readFileSync(join(root, 'host', '.unit', name), 'utf8'))
    .join('\n')

const first = build()
ok('the first build builds', first.failed === 0, first.errors.join(' | '))

const emitted = artifacts()
const entries = files(store)
const kinds = new Set(entries.map(file => relative(store, file).split(sep)[0]))
ok('it stored entries of the mill and the unit kinds', kinds.has('mill') && kinds.has('unit'), [...kinds].join(', '))

// a third cut short, a third garbage, a third a good file of the wrong shape
entries.forEach((file, at) => {
  const bytes = readFileSync(file)

  if (at % 3 === 0) {
    writeFileSync(file, bytes.subarray(0, Math.floor(bytes.length / 2)))
  } else if (at % 3 === 1) {
    writeFileSync(file, Buffer.from('not a cache entry'))
  } else {
    writeFileSync(file, gzipSync(Buffer.from('{}')))
  }
})

const second = build()
ok('every entry damaged, the project still builds', second.failed === 0, second.errors.join(' | '))
ok('to the same output', artifacts() === emitted)
ok('and it built every unit again, reading none of the damage', second.built === first.built, `${second.built} of ${first.built}`)

const readable = files(store).filter(file => {
  try {
    return JSON.stringify(JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'))) !== '{}'
  } catch {
    return false
  }
})
ok('every damaged entry was written again, whole', readable.length === files(store).length, `${readable.length} of ${files(store).length}`)

const third = build()
ok('and the build after that reads them', third.failed === 0 && third.built === 0, `${third.built} built`)

console.log(`\ncache-health: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
