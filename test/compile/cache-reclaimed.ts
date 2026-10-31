// A long-lived process keeps writing after another process reclaims its namespace (term-self-host-001-0471). The
// store remembers each shard folder it made, so once `reclaimStaleVersions` in another process removes this process's
// `<kind>/<version>` folder, every later save used to fail ENOENT in silence for the life of the process: the language
// server and the daemon stopped filling the store. On a failed write the store forgets the shard, makes it again and
// retries once.
//
// Held on both stores: the TypeScript one (call/code/cache-store.ts, what tsx callers use) and the port of
// call/code/work/cache/compile-store.tree (what host/line.js runs), or the file CACHE_STORE_PORT names (a draft's
// port). Each case saves an entry, removes the namespace folder, saves a second entry to the same shard, and loads the
// second entry back.
// Run: npx tsx test/compile/cache-reclaimed.ts

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { diskCacheStore } from '@term/call/code/cache-store'

type Store = {
  load: (kind: string, key: string) => string | undefined
  save: (kind: string, key: string, value: string) => void
}

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

const TERM = resolve(import.meta.dirname, '../..')
const PORT =
  process.env.CACHE_STORE_PORT ??
  join(TERM, 'deck/call/host/port/code/work/cache/compile-store.ts')

// two keys in one shard (the first two characters), so the second save meets the remembered shard folder
const FIRST = `ab${'0'.repeat(62)}`
const SECOND = `ab${'1'.repeat(62)}`

function reclaimedCase(name: string, make: (dir: string) => Store): void {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cache-reclaimed-')))
  const store = make(dir)

  store.save('unit', FIRST, 'first')
  ok(`${name}: the first entry reads back`, store.load('unit', FIRST) === 'first')

  // what another process's reclaimStaleVersions does: the whole `<kind>/<version>` folder goes
  const kindDir = join(dir, 'unit')
  for (const slug of readdirSync(kindDir)) {
    rmSync(join(kindDir, slug), { recursive: true, force: true })
  }
  ok(`${name}: the namespace is gone`, readdirSync(kindDir).length === 0)

  store.save('unit', SECOND, 'second')
  const back = store.load('unit', SECOND)
  ok(
    `${name}: a save after the reclaim reads back`,
    back === 'second',
    `read ${JSON.stringify(back)}`,
  )
  ok(
    `${name}: the first entry is a miss, not a crash`,
    store.load('unit', FIRST) === undefined,
  )
  ok(`${name}: no temp is left`, !leftTemp(kindDir))

  rmSync(dir, { recursive: true, force: true })
}

function leftTemp(at: string): boolean {
  if (!existsSync(at)) {
    return false
  }
  for (const entry of readdirSync(at, { recursive: true })) {
    if (String(entry).endsWith('.tmp')) {
      return true
    }
  }
  return false
}

// CACHE_STORE_TS names a draft of call/code/cache-store.ts to hold in place of the live one
const typescript = process.env.CACHE_STORE_TS
  ? ((await import(pathToFileURL(process.env.CACHE_STORE_TS).href)) as {
      diskCacheStore: typeof diskCacheStore
    }).diskCacheStore
  : diskCacheStore
reclaimedCase('typescript', dir => typescript(dir, 'reclaimed'))

const port = (await import(pathToFileURL(PORT).href)) as {
  diskCacheStore: (dir: string, version: unknown) => Store
}
reclaimedCase('port', dir => port.diskCacheStore(dir, 'reclaimed'))

console.log(`\ncache-reclaimed: ${pass} pass, ${fail} fail`)
process.exit(fail === 0 ? 0 : 1)
