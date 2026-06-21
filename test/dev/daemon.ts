// Daemon test (Tier 4). Starts the real daemon and drives it over HTTP: analyze a document (warm), get its
// diagnostics, re-analyze after an edit (still warm, re-checked incrementally), report a real type error, and drop a
// document. Proves the shared warm-analyzer process end to end. Run: npx tsx test/dev/daemon.ts

import { startDaemon } from '@cluesurf/make/code/dev/daemon'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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

const SEED = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)
const PORT = 39631
const FILE = path.join(SEED, 'daemon-doc.tree') // a path; text is supplied per request, no disk read needed

const callerSrc = `task caller\n  like number\n  send back\n    call helper\n      code 5\n`
const helperOk = `task helper\n  take n, like number\n  like number\n  send back\n    read n\n`
const helperBad = `task helper\n  take n, like number\n  like number\n  send back\n    text <oops>\n`

async function post(
  endpoint: string,
  body: unknown,
): Promise<{ status: number; json: any }> {
  const r = await fetch(`http://localhost:${PORT}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: r.status, json: await r.json() }
}
async function get(endpoint: string): Promise<any> {
  return (await fetch(`http://localhost:${PORT}${endpoint}`)).json()
}

async function main(): Promise<void> {
  const daemon = startDaemon({ root: SEED, port: PORT, env: 'node' })
  await new Promise(r => setTimeout(r, 250))

  // a clean document: no diagnostics
  const clean = await post('/analyze', {
    file: FILE,
    text: `${helperOk}\n${callerSrc}`,
  })
  ok(
    'daemon analyzes a clean document (no diagnostics)',
    clean.status === 200 && clean.json.diagnostics.length === 0,
    JSON.stringify(clean.json),
  )

  // the document is now warm
  const health1 = await get('/health')
  ok(
    'the document is kept warm',
    health1.warm === 1,
    JSON.stringify(health1),
  )

  // edit it to introduce a real type error -> reported, still one warm document
  const broken = await post('/analyze', {
    file: FILE,
    text: `${helperBad}\n${callerSrc}`,
  })
  ok(
    'daemon reports a real type error after an edit',
    broken.json.diagnostics.some((d: { message: string }) =>
      /expected/.test(d.message),
    ),
    JSON.stringify(broken.json.diagnostics),
  )
  const health2 = await get('/health')
  ok('still one warm document after the edit', health2.warm === 1)

  // fix it again -> clean
  const fixed = await post('/analyze', {
    file: FILE,
    text: `${helperOk}\n${callerSrc}`,
  })
  ok(
    'daemon clears the error when fixed',
    fixed.json.diagnostics.length === 0,
  )

  // bad request handling
  const bad = await post('/analyze', { nope: true })
  ok('daemon rejects a malformed request', bad.status === 400)

  // closing the document drops its warm state
  await post('/close', { file: FILE })
  const health3 = await get('/health')
  ok('closing a document drops its warm state', health3.warm === 0)

  daemon.close()
  console.log(`\ndev/daemon: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
