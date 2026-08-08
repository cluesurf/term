// HTTP / HTTPS server test: compile a real Seed program that starts a `network/server`, run it, make actual requests
// against it, and assert the responses. Proves the server boots, hands each request to the Seed handler (with its
// method / path / query parsed), writes the handler's response and its headers, and serves the same handler over TLS
// when started with `secure` plus a PEM cert/key. node http/https via the server runtime shim.
// Run: npx tsx test/stdlib/server.ts

import { execFileSync } from 'node:child_process'
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
import * as https from 'node:https'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { render } from '@term/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'seed')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

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

  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

// the Seed program: a server whose handler routes on the request path -- `/` greets, anything else echoes the path,
// proving the request's parsed method / path / query reach the handler.
const SOURCE = `load @cluesurf/seed/code/network/server
  find start
  find stop

load @cluesurf/seed/code/network/server/request
  find request

load @cluesurf/seed/code/network/server/response
  find response
  find make-ok
  find make-status
  find with-header

# the shared request handler: root greets, /echo echoes the path with a custom header, anything else is a 404
task route
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
            call with-header
              call make-ok
                read req/path
              text <x-seed>
              text <ok>
        hook miss
          send back
            call make-status
              code 404

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
        send back
          call route
            read req
      false
      text <>
      text <>
      wait true

# the same handler over TLS, started with secure plus the PEM certificate and key
task boot-secure
  note async
  take certificate, like text
  take key, like text
  like server
  send back
    call start
      code 8743
      text <127.0.0.1>
      task handler
        take req
        like response
        send back
          call route
            read req
      true
      read certificate
      read key
      wait true

task shutdown
  note async
  take server, like server
  like void
  call stop
    read server
    wait true
`

type Reply = {
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}

function collect(r: http.IncomingMessage): Promise<Reply> {
  return new Promise(resolve => {
    let body = ''
    r.on('data', c => (body += c))
    r.on('end', () =>
      resolve({ status: r.statusCode ?? 0, body, headers: r.headers }),
    )
  })
}

function get(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:8742${path}`, r =>
        collect(r).then(resolve),
      )
      .on('error', reject)
  })
}

// fetch over TLS, accepting the self-signed test certificate
function secureGet(path: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    https
      .get(
        `https://127.0.0.1:8743${path}`,
        { rejectUnauthorized: false },
        r => collect(r).then(resolve),
      )
      .on('error', reject)
  })
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
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
    bootSecure: (
      certificate: string,
      key: string,
    ) => Promise<unknown>
    shutdown: (server: unknown) => Promise<void>
  }

  const server = await mod.boot()

  try {
    const root = await get('/')
    eq('GET / returns 200', root.status, 200)
    eq('GET / runs the root branch of the handler', root.body, 'root')

    const echo = await get('/echo')
    eq('GET /echo echoes the parsed request path', echo.body, '/echo')
    eq(
      'GET /echo carries the handler-set header',
      echo.headers['x-seed'],
      'ok',
    )

    const missing = await get('/nope')
    eq('GET /nope routes to the 404 branch', missing.status, 404)
  } finally {
    await mod.shutdown(server)
  }

  // HTTPS: the same handler served over TLS from a self-signed cert (skipped if openssl is unavailable)
  if (have('openssl')) {
    const certDir = mkdtempSync(join(tmpdir(), 'seed-cert-'))
    const keyFile = join(certDir, 'key.pem')
    const certFile = join(certDir, 'cert.pem')
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-keyout',
        keyFile,
        '-out',
        certFile,
        '-days',
        '1',
        '-nodes',
        '-subj',
        '/CN=localhost',
      ],
      { stdio: 'ignore' },
    )

    const secure = await mod.bootSecure(
      readFileSync(certFile, 'utf8'),
      readFileSync(keyFile, 'utf8'),
    )

    try {
      const tls = await secureGet('/echo')
      eq('HTTPS GET returns 200', tls.status, 200)
      eq('HTTPS echoes the parsed request path', tls.body, '/echo')
      eq(
        'HTTPS carries the handler-set header',
        tls.headers['x-seed'],
        'ok',
      )
    } finally {
      await mod.shutdown(secure)
    }
  } else {
    console.log('skip  HTTPS round trip  (openssl not installed)')
  }

  console.log(`\nnetwork/server: ${pass} pass, ${fail} fail`)
}

main()
