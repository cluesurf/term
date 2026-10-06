// tree/code over HTTP, end to end, for a Term app: a Term handler built from @term/site's `code-of-request` and
// `code-response`, served by the real node transport (site/code/http/native/node/runtime/transport.ts), called with
// fetch. The handler echoes what it reads, so the bytes back must be the canonical bytes of what was sent: plain,
// packed with `Content-Encoding: zstd` both ways, refused when the packed body is past the limit, and left alone for
// a client that does not take zstd. The reference codec (compile/host-code.ts) is the oracle.
// Run: npx tsx test/compile/tree-code-http.ts

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { transformSync } from 'esbuild'
import type { Data } from '@term/make/code/compile/host'
import { decodeTree, encodeTree } from '@term/make/code/compile/host-code'

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
// inside the Term root, so the transport's `hono` imports resolve against its node_modules
const ROOT = join(TERM, 'tmp/tree-code-http')

const APP = `load @term/site/http/code
  find code-response
  find code-of-request
  find is-code-request
  find accepts-code

load @term/site/http/http
  find request
  find response

# what a client sent, as tree/code, sent back
task echo
  take request, like request
  like response
  send back
    call code-response
      call code-of-request
        read request

task is-code
  take request, like request
  like boolean
  send back
    call is-code-request
      read request

task takes-code
  take request, like request
  like boolean
  send back
    call accepts-code
      read request
`

function hex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

function records(count: number): Data {
  const roles = ['admin', 'editor', 'viewer']
  const list: Data[] = []

  for (let at = 0; at < count; at++) {
    list.push({
      kind: 'hash',
      list: [
        { name: 'id', base: { kind: 'number', value: 1000 + at } },
        { name: 'name', base: { kind: 'text', value: `user-${(at * 7919) % 500}` } },
        { name: 'role', base: { kind: 'text', value: roles[at % 3] as string } },
        { name: 'active', base: { kind: 'flag', value: at % 5 !== 0 } },
        { name: 'score', base: { kind: 'decimal', value: ((at * 31) % 1000) / 8 } },
      ],
    })
  }

  return { kind: 'hash', list: [{ name: 'users', base: { kind: 'list', list } }] }
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(join(ROOT, 'link/@term'), { recursive: true })
  mkdirSync(join(ROOT, 'code'), { recursive: true })

  for (const name of ['base', 'bind', 'host', 'site']) {
    symlinkSync(join(TERM, 'deck', name), join(ROOT, 'link/@term', name))
  }

  writeFileSync(join(ROOT, 'deck.tree'), 'deck @probe/tree-code-http\n  mark <0.0.0>\n')
  writeFileSync(join(ROOT, 'code/app.tree'), APP)

  // the app, emitted for node with its runtime prelude, through the CLI the way `term make` builds it
  let emitted: string

  try {
    emitted = execFileSync('node', [join(TERM, 'host/line.js'), 'make', '--emit', 'node', 'code/app.tree', '-q'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    ok('the app compiles', false, String((error as { stderr?: string }).stderr ?? error).slice(0, 2000))
    finish()
    return
  }

  ok('the app compiles for node', emitted.includes('codeResponse') || emitted.includes('code_response'), emitted.slice(0, 200))

  const appFile = join(ROOT, 'app.mjs')

  // the emitted module exports its top-level tasks itself
  writeFileSync(appFile, transformSync(emitted, { loader: 'ts', format: 'esm' }).code)

  const app = await import(pathToFileURL(appFile).href)

  // the transport the app runs, as written: a prelude fragment, exported here so the test can hold it
  const shim = readFileSync(join(TERM, 'deck/site/code/http/native/node/runtime/transport.ts'), 'utf8')
  const transportFile = join(ROOT, 'transport.mjs')

  writeFileSync(transportFile, transformSync(`${shim}\nexport { transport }\n`, { loader: 'ts', format: 'esm' }).code)

  const { transport } = await import(pathToFileURL(transportFile).href)
  const port = 39000 + Math.floor(Math.random() * 2000)
  const server = transport.createServer((request: unknown) => app.echo(request))

  server.listen(port)
  await new Promise(resolve => setTimeout(resolve, 300))

  const url = `http://127.0.0.1:${port}/echo`
  const decompress = (packed: Uint8Array, size: number): Uint8Array => new Uint8Array(zstdDecompressSync(packed, { maxOutputLength: size }))

  try {
    // ---- a small value, plain both ways ----

    const small: Data = { kind: 'hash', list: [{ name: 'greeting', base: { kind: 'text', value: 'héllo 世界 😀' } }, { name: 'count', base: { kind: 'number', value: 3 } }] }
    const smallBytes = encodeTree(small)
    const first = await fetch(url, { method: 'POST', body: smallBytes, headers: { 'content-type': 'application/tree+code', accept: 'application/tree+code' } })
    const firstBody = new Uint8Array(await first.arrayBuffer())

    ok('a tree/code request is answered 200 with application/tree+code', first.status === 200 && (first.headers.get('content-type') ?? '').startsWith('application/tree+code'), `${first.status} ${first.headers.get('content-type')}`)
    ok('the bytes back are the canonical bytes of what was sent (the body was read as bytes, never as UTF-8)', hex(firstBody) === hex(smallBytes), `\n      got  ${hex(firstBody)}\n      sent ${hex(smallBytes)}`)
    ok('a small body is not packed', first.headers.get('content-encoding') === null)

    // ---- a large value, packed both ways ----

    const large = records(2000)
    const largeBytes = encodeTree(large)
    const packedRequest = zstdCompressSync(largeBytes)
    const second = await fetch(url, {
      method: 'POST',
      body: packedRequest,
      headers: { 'content-type': 'application/tree+code', 'content-encoding': 'zstd', 'accept-encoding': 'zstd' },
    })
    const secondRaw = new Uint8Array(await second.arrayBuffer())
    const encoding = second.headers.get('content-encoding')
    // fetch unpacks a zstd response itself on this Node and leaves the header saying zstd, so the bytes decide: a
    // tree/code header means they are already plain
    const unpacked = secondRaw[0] === 0xd3 && secondRaw[1] === 0x54 && secondRaw[2] === 0x52
    const secondPlain = encoding === 'zstd' && !unpacked ? new Uint8Array(zstdDecompressSync(secondRaw)) : secondRaw

    ok(`2,000 records: ${largeBytes.length} canonical bytes, sent as ${packedRequest.length} packed`, packedRequest.length < largeBytes.length)
    ok('a zstd request body is unpacked by the transport, and the answer is the canonical bytes', hex(secondPlain) === hex(largeBytes), `got ${secondPlain.length} bytes, sent ${largeBytes.length}`)
    ok('the answer is packed for a client that takes zstd (Content-Encoding: zstd)', encoding === 'zstd', `content-encoding ${encoding}`)
    ok('the answer says it varies by Accept-Encoding', (second.headers.get('vary') ?? '').toLowerCase().includes('accept-encoding'))

    const decoded = decodeTree(secondPlain, { decompress })

    ok('the reference codec reads the answer back to the value sent', decoded.ok && JSON.stringify(decoded.values[0]) === JSON.stringify(large))

    // ---- a client that does not take zstd gets the bytes as they are ----

    const third = await fetch(url, { method: 'POST', body: largeBytes, headers: { 'content-type': 'application/tree+code', 'accept-encoding': 'identity' } })
    const thirdBody = new Uint8Array(await third.arrayBuffer())

    ok('a client that does not take zstd gets the canonical bytes unpacked', third.headers.get('content-encoding') === null && hex(thirdBody) === hex(largeBytes), `content-encoding ${third.headers.get('content-encoding')}`)

    // ---- a packed body past the limit is refused before the handler sees it ----

    const bomb = zstdCompressSync(Buffer.alloc(80 * 1024 * 1024))
    const fourth = await fetch(url, { method: 'POST', body: bomb, headers: { 'content-type': 'application/tree+code', 'content-encoding': 'zstd' } })

    ok(`a ${bomb.length}-byte packed body that unpacks past 64 MiB is refused with 413`, fourth.status === 413, String(fourth.status))

    // ---- the request helpers ----

    const asked = { method: 'POST', path: '/x', body: '', headers: new Map([['content-type', 'Application/Tree+Code; charset=binary'], ['accept', 'text/html, application/tree+code;q=0.9']]), query: new Map() }
    const plainAsk = { method: 'GET', path: '/x', body: '', headers: new Map([['accept', 'text/html']]), query: new Map() }

    ok('is-code-request reads the content-type, its case and parameters aside', app.isCode(asked) === true && app.isCode(plainAsk) === false)
    ok('accepts-code reads the accept header', app.takesCode(asked) === true && app.takesCode(plainAsk) === false)
  } finally {
    server.close()
  }

  finish()
}

function finish(): void {
  console.log('')
  console.log(`tree-code-http: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }

  process.exit(0)
}

main()
