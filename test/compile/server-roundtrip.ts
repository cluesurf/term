// Compiled-server round trip: compile a real Seed `network/server` program to a NATIVE backend (rust / kotlin / swift),
// build it with the real toolchain into a server binary, SPAWN it, make actual HTTP requests against it from node, and
// assert the responses -- then kill it. This is the inverse of the network/http test (which spawns a node peer and runs
// the Seed CLIENT): here the compiled Seed code is the SERVER. The servers are blocking and std-only (no async runtime /
// external crate), so only the base compilers are needed. A missing toolchain is reported as skipped, never a failure.
// Run: npx tsx test/compile/server-roundtrip.ts

import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import * as http from 'node:http'
import { parse } from '@cluesurf/make/code/parser/tree'
import { mill } from '@cluesurf/make/code/compile/mill'
import { expandTemplates } from '@cluesurf/make/code/compile/template'
import { resolve as resolveNames } from '@cluesurf/make/code/check/resolve'
import { check } from '@cluesurf/make/code/check/infer'
import { resolveAsync } from '@cluesurf/make/code/check/async-resolve'
import { simplify } from '@cluesurf/make/code/ir/simplify'
import { collectModules } from '@cluesurf/make/code/compile/load'
import type { Source } from '@cluesurf/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@cluesurf/make/code/compile/native'
import { emitRust } from '@cluesurf/make/code/compile/rust'
import {
  emitKotlin,
  hoistKotlinImports,
} from '@cluesurf/make/code/compile/kotlin'
import { emitSwift } from '@cluesurf/make/code/compile/swift'
import type { Program } from '@cluesurf/make/code/compile/node'

const baseTree = join(process.cwd(), 'deck', 'base')

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

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}  (= ${JSON.stringify(got)})`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

function frontEnd(
  text: string,
  env: 'rust' | 'swift' | 'kotlin',
): Program {
  const resolver = withNativeEnv(env, stdlib)
  const sources = collectModules({ file: 'main.tree', text }, resolver)
    .sources

  const program: Program = []
  const roots = new Set<string>()

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error('parse failed: ' + unit.file)
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(
        'mill failed ' +
          unit.file +
          ': ' +
          built.diagnostics.map(d => d.message).join(', '),
      )
    }

    if (unit.file === 'main.tree') {
      for (const node of built.program) {
        if (node.form === 'function') {
          roots.add(node.name)
        }
      }
    }

    program.push(...built.program)
  }

  resolveNames(program, 'main.tree')
  check(program, 'main.tree')
  resolveAsync(program)

  return simplify(program, roots)
}

// poll until something is listening on the port, then resolve (or reject after the timeout)
function waitForPort(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs

  return new Promise((resolve, reject) => {
    const tryOnce = (): void => {
      const socket = net.connect(port, '127.0.0.1')
      socket.on('connect', () => {
        socket.destroy()
        resolve()
      })
      socket.on('error', () => {
        socket.destroy()

        if (Date.now() > deadline) {
          reject(new Error('server did not start'))
        } else {
          setTimeout(tryOnce, 100)
        }
      })
    }

    tryOnce()
  })
}

function get(
  port: number,
  path: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, r => {
        let body = ''
        r.on('data', c => (body += c))
        r.on('end', () =>
          resolve({ status: r.statusCode ?? 0, body }),
        )
      })
      .on('error', reject)
  })
}

// the Seed server program: serve on PORT, echoing the request path (so a fetch proves method/path parsing + the handler)
const SERVER = (port: number): string => `load @cluesurf/base/code/network/server
  find serve

load @cluesurf/base/code/network/server/response
  find response
  find make-ok

task boot
  like void
  call serve
    code ${port}
    text <127.0.0.1>
    task handler
      take req
      like response
      send back
        call make-ok
          read req/path
`

async function rustServer(): Promise<void> {
  const name = 'rust: compiled HTTP server echoes the request path'

  if (!have('rustc')) {
    skip++
    console.log(`skip  ${name}  (rustc not installed)`)

    return
  }

  const port = 8771
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-rs-'))
  const program = frontEnd(SERVER(port), 'rust')
  const main = `\nfn main() { boot(); }\n`
  const file = join(dir, 'server.rs')
  writeFileSync(
    file,
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}${main}`,
  )

  const exe = join(dir, 'server')

  try {
    execFileSync(
      'rustc',
      ['-A', 'warnings', '--edition', '2021', file, '-o', exe],
      { stdio: 'pipe' },
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (rustc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 600)})`,
    )

    return
  }

  const proc = spawn(exe, { stdio: 'ignore' })

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('rust: compiled server returns 200', echo.status, 200)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (request error: ${String(e)})`)
  } finally {
    proc.kill('SIGKILL')
  }
}

async function kotlinServer(): Promise<void> {
  const name = 'kotlin: compiled HTTP server echoes the request path'

  if (!have('kotlinc') || !have('java')) {
    skip++
    console.log(`skip  ${name}  (kotlinc/java not installed)`)

    return
  }

  const port = 8772
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-kt-'))
  const program = frontEnd(SERVER(port), 'kotlin')
  const file = join(dir, 'server.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(
        program,
      )}\nfun main() { boot() }\n`,
    ),
  )

  const jar = join(dir, 'server.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], {
      stdio: 'pipe',
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (kotlinc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 600)})`,
    )

    return
  }

  const proc = spawn('java', ['-jar', jar], { stdio: 'ignore' })

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('kotlin: compiled server returns 200', echo.status, 200)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (request error: ${String(e)})`)
  } finally {
    proc.kill('SIGKILL')
  }
}

async function swiftServer(): Promise<void> {
  const name = 'swift: compiled HTTP server echoes the request path'

  if (!have('swiftc')) {
    skip++
    console.log(`skip  ${name}  (swiftc not installed)`)

    return
  }

  const port = 8773
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-sw-'))
  const program = frontEnd(SERVER(port), 'swift')
  const file = join(dir, 'server.swift')
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nboot()\n`,
  )

  const exe = join(dir, 'server')

  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swiftc error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 600)})`,
    )

    return
  }

  const proc = spawn(exe, { stdio: 'ignore' })

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('swift: compiled server returns 200', echo.status, 200)
  } catch (e) {
    fail++
    console.log(`FAIL  ${name}  (request error: ${String(e)})`)
  } finally {
    proc.kill('SIGKILL')
  }
}

async function main(): Promise<void> {
  await rustServer()
  await kotlinServer()
  await swiftServer()

  console.log(
    `\nserver-roundtrip: ${pass} pass, ${fail} fail, ${skip} skipped`,
  )
  process.exit(fail > 0 ? 1 : 0)
}

main()
