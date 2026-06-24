// HTTP server test: compile a real Seed program that starts a `network/server`, run it, make actual HTTP requests
// against it, and assert the responses. Proves the server boots, hands each request to the Seed handler (with its
// method / path / query parsed), and writes the handler's response. node http via the server runtime shim.
// Run: npx tsx test/stdlib/server.ts

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as http from 'node:http'
import { compile } from '@cluesurf/make/code/compile/compile'
import type { Source } from '@cluesurf/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@cluesurf/make/code/compile/native'
import { render } from '@cluesurf/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'base')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/base/'

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const prefix = '@cluesurf/base/'

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// the Seed program: a server whose handler routes on the request path -- `/` greets, anything else echoes the path,
// proving the request's parsed method / path / query reach the handler.
const SOURCE = `load @cluesurf/base/code/network/server
  find start
  find stop

load @cluesurf/base/code/network/server/request
  find request

load @cluesurf/base/code/network/server/response
  find response
  find make-ok
  find make-status

task boot
  note async
  like server
  send back
    call start
      code 8742
      text <127.0.0.1>
      task handler
        take req
        like response
        fork test
          hook test
            call is-equal
              read req/path
              text </>
          hook hold
            send back
              call make-ok
                text <root>
          hook miss
            fork test
              hook test
                call is-equal
                  read req/path
                  text </echo>
              hook hold
                send back
                  call make-ok
                    read req/path
              hook miss
                send back
                  call make-status
                    code 404
      false
      text <>
      text <>
      wait true

task shutdown
  note async
  take server, like server
  like void
  call stop
    read server
    wait true
`

function get(
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:8742${path}`, r => {
        let body = ''
        r.on('data', c => (body += c))
        r.on('end', () =>
          resolve({ status: r.statusCode ?? 0, body }),
        )
      })
      .on('error', reject)
  })
}

let pass = 0
let fail = 0

function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function main(): Promise<void> {
  const result = compile(
    { file: 'main.tree', text: SOURCE },
    { resolve: withNativeEnv('node', stdlib) },
  )

  if (!result.ok) {
    for (const d of result.diagnostics) {
      console.log(render(d, SOURCE.split('\n'), false))
    }

    throw new Error('compile failed')
  }

  const ts =
    nativePrelude(result.program, 'node', readRuntime) +
    '\n' +
    result.typescript
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-'))
  const file = join(dir, 'm.ts')
  writeFileSync(file, ts)

  const mod = (await import(pathToFileURL(file).href)) as {
    boot: () => Promise<unknown>
    shutdown: (server: unknown) => Promise<void>
  }

  const server = await mod.boot()

  try {
    const root = await get('/')
    eq('GET / returns 200', root.status, 200)
    eq('GET / runs the root branch of the handler', root.body, 'root')

    const echo = await get('/echo')
    eq('GET /echo echoes the parsed request path', echo.body, '/echo')

    const missing = await get('/nope')
    eq('GET /nope routes to the 404 branch', missing.status, 404)
  } finally {
    await mod.shutdown(server)
  }

  console.log(`\nnetwork/server: ${pass} pass, ${fail} fail`)
}

main()
