// Dev server integration test (Tier 3). Starts the real dev server on a tiny 2-module app, then over real HTTP:
// serves the app shell, serves a compiled module as native ESM, opens the SSE channel (receives `connected`), and on a
// change pushes an HMR message. Proves lazy serving + the SSE HMR plumbing end to end. Run: npx tsx test/dev/server.ts

import { startDevServer } from '@cluesurf/make/code/dev/server'
import { applyHmr } from '@cluesurf/make/code/dev/client'
import type { HmrMessage } from '@cluesurf/make/code/dev/client'
import * as fs from 'node:fs'
import * as os from 'node:os'
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
const PORT = 39512

// a tiny 2-module app in a temp dir (the entry loads a helper)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-dev-'))
fs.writeFileSync(
  path.join(dir, 'helper.tree'),
  `task helper-value\n  like number\n  send back\n    code 42\n`,
)
const entry = path.join(dir, 'entry.tree')
fs.writeFileSync(
  entry,
  `load ./helper\n  find helper-value\n\ntask main\n  like number\n  send back\n    call helper-value\n`,
)

// read one SSE `data:` event from a stream reader
async function readEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<HmrMessage | undefined> {
  const decoder = new TextDecoder()
  let buffer = ''
  for (let i = 0; i < 50; i++) {
    const { value, done } = await reader.read()
    if (done) return undefined
    buffer += decoder.decode(value, { stream: true })
    const match = buffer.match(/data: (.+)\n\n/)
    if (match) return JSON.parse(match[1]!) as HmrMessage
  }
  return undefined
}

async function main(): Promise<void> {
  const server = startDevServer({
    root: SEED,
    entry,
    port: PORT,
    env: 'browser',
  })
  await new Promise(r => setTimeout(r, 300))

  // 1. the app shell loads the client + the entry module
  const shell = await (await fetch(`http://localhost:${PORT}/`)).text()
  ok(
    'serves the app shell',
    shell.includes('/@seed/client.mjs') && shell.includes('/@mod/'),
    shell.slice(0, 120),
  )
  const entryUrl = shell.match(/src="(\/@mod\/[^"]+)"/)?.[1] ?? ''
  ok('shell references the entry module url', entryUrl.length > 0)

  // 2. the entry module is served as native ESM
  const modResponse = await fetch(`http://localhost:${PORT}${entryUrl}`)
  const modCode = await modResponse.text()
  ok(
    'serves a compiled module as javascript',
    modResponse.status === 200 &&
      (modResponse.headers.get('content-type') ?? '').includes(
        'javascript',
      ) &&
      modCode.includes('function main'),
    `${modResponse.status} ${modResponse.headers.get('content-type')}`,
  )

  // 3. the client runtime is served
  const client = await (
    await fetch(`http://localhost:${PORT}/@seed/client.mjs`)
  ).text()
  ok(
    'serves the hmr client runtime',
    client.includes('EventSource') && client.includes('applyHmr'),
  )

  // 4. the SSE channel sends `connected`, then an HMR message when a module changes
  const sse = await fetch(`http://localhost:${PORT}/@seed/hmr`)
  const reader = sse.body!.getReader()
  const first = await readEvent(reader)
  ok(
    'sse sends connected on open',
    first?.type === 'connected',
    JSON.stringify(first),
  )

  const result = server.update(entry) // the entry is a non-accepting root -> full reload
  ok(
    'update of a non-accepting root decides full-reload',
    result.type === 'full-reload',
    JSON.stringify(result),
  )
  const pushed = await readEvent(reader)
  ok(
    'sse pushes the hmr message to the client',
    pushed?.type === 'full-reload',
    JSON.stringify(pushed),
  )

  await reader.cancel()
  server.close()
  fs.rmSync(dir, { recursive: true, force: true })

  // 5. the pure client logic applies messages correctly (headless)
  let reloaded = false
  await applyHmr(
    { type: 'full-reload' },
    {
      reload: () => {
        reloaded = true
      },
      reimport: async () => ({}),
      acceptOf: () => undefined,
      log: () => {},
    },
  )
  ok('client applyHmr: full-reload triggers a reload', reloaded)

  let accepted: unknown
  await applyHmr(
    {
      type: 'update',
      updates: [
        { boundary: '/z.mjs', accepted: '/z.mjs', timestamp: 7 },
      ],
    },
    {
      reload: () => {},
      reimport: async () => ({ fresh: true }),
      acceptOf: () => m => {
        accepted = m
      },
      log: () => {},
    },
  )
  ok(
    'client applyHmr: update re-imports and runs the accept callback',
    JSON.stringify(accepted) === JSON.stringify({ fresh: true }),
    JSON.stringify(accepted),
  )

  console.log(`\ndev/server: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
