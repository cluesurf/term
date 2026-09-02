// Remote cache test (Tier 5). Stands up the real remote cache server, pushes one project's local cache to it, pulls
// into a second empty cache, and confirms a cold compile in the second project then hits the warmed (pulled) disk
// cache. Proves the share-across-machines protocol end to end, headlessly. Run: npx tsx test/compile/remote-cache.ts

import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import { diskCacheStore } from '@term/call/code/cache-store'
import {
  pullRemoteCache,
  pushRemoteCache,
  startRemoteCacheServer,
} from '@term/call/code/remote-cache'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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

const SOURCE = `task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 3\n`
const PORT = 39623
const TOKEN = 'secret'

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-remote-'))
  const store = path.join(root, 'store')
  const projectA = path.join(root, 'a', '.seed', 'cache')
  const projectB = path.join(root, 'b', '.seed', 'cache')
  fs.mkdirSync(projectA, { recursive: true })
  fs.mkdirSync(projectB, { recursive: true })

  const server = startRemoteCacheServer({
    storeDir: store,
    port: PORT,
    token: TOKEN,
  })

  const endpoint = `http://localhost:${PORT}`
  await new Promise(r => setTimeout(r, 200))

  // project A: compile (populates A's local disk cache), then push to the remote
  const cacheA = new CompileCache(diskCacheStore(projectA, 'v1'), 'v1')
  const built = compile(
    { file: 'a.tree', text: SOURCE },
    { cache: cacheA },
  )

  ok(
    'project A compiles + writes its local cache',
    built.ok && fs.readdirSync(path.join(projectA, 'mill')).length > 0,
  )

  const pushed = await pushRemoteCache(projectA, endpoint, TOKEN)
  ok(
    'push uploads A local artifacts to the remote',
    pushed > 0,
    `pushed ${pushed}`,
  )
  ok(
    'a second push is a no-op (remote already has them)',
    (await pushRemoteCache(projectA, endpoint, TOKEN)) === 0,
  )

  // project B: empty cache, pull from the remote to warm it
  const pulled = await pullRemoteCache(projectB, endpoint, TOKEN)
  ok(
    'pull downloads the artifacts into B',
    pulled > 0 && pulled === pushed,
    `pulled ${pulled}`,
  )

  // a cold compile in B (fresh in-memory cache, same disk dir) now hits the pulled artifacts, rebuilding nothing
  const cacheB = new CompileCache(diskCacheStore(projectB, 'v1'), 'v1')
  const coldB = compile(
    { file: 'a.tree', text: SOURCE },
    { cache: cacheB },
  )

  ok(
    'B cold compile hits the warmed remote cache',
    cacheB.misses === 0 && cacheB.diskHits > 0,
    `misses ${cacheB.misses} diskHits ${cacheB.diskHits}`,
  )
  ok(
    'B output equals A output',
    coldB.ok && built.ok && coldB.typescript === built.typescript,
  )

  // auth: a wrong token is rejected
  const unauthorized = await fetch(`${endpoint}/index`, {
    headers: { authorization: 'Bearer wrong' },
  })

  ok(
    'the remote rejects a bad token',
    unauthorized.status === 401,
    `${unauthorized.status}`,
  )

  server.close()
  fs.rmSync(root, { recursive: true, force: true })
  console.log(`\nremote-cache: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
