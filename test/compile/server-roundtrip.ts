// Compiled-server round trip: compile a real Seed `network/server` program to a NATIVE backend (rust / kotlin / swift),
// build it with the real toolchain into a server binary, SPAWN it, make actual HTTP requests against it from node, and
// assert the responses -- then kill it. This is the inverse of the network/http test (which spawns a node peer and runs
// the Seed CLIENT): here the compiled Seed code is the SERVER.
//
// THE SERVERS ARE NO LONGER std-only. They used to be hand-rolled accept loops, which is why this harness used to
// build rust with a bare `rustc` and kotlin and swift with bare compilers. They are hyper, Ktor and Hummingbird
// now, so rust builds as a cargo project and the other two take the dependency flags the per-language scripts
// resolve (task/term/native/{swift,kotlin}.sh). A missing toolchain is reported as skipped, never a failure.
// Run: npx tsx test/compile/server-roundtrip.ts

import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import * as http from 'node:http'
import { nativeFlags } from './native-flags'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import {
  emitKotlin,
  hoistKotlinImports,
} from '@term/make/code/compile/kotlin'
import { emitSwift } from '@term/make/code/compile/swift'
import type { Program } from '@term/make/code/compile/node'

const baseTree = join(process.cwd(), 'deck', 'seed')

// the stdlib's own modules import each other as `@term/seed/...` (the Term rename); older test programs still say
// `@cluesurf/seed/...`. Both spell the same package, so the resolver accepts either prefix.
const STDLIB_PREFIX = /^@(?:cluesurf|term)\/seed\//

const stdlib = (path: string): Source | undefined => {
  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const file = join(
    baseTree,
    `${path.replace(STDLIB_PREFIX, '')}.tree`,
  )

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  if (!STDLIB_PREFIX.test(path)) {
    return undefined
  }

  const file = join(baseTree, path.replace(STDLIB_PREFIX, ''))

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
): Promise<{
  status: number
  body: string
  headers: http.IncomingHttpHeaders
}> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, r => {
        let body = ''
        r.on('data', c => (body += c))
        r.on('end', () =>
          resolve({
            status: r.statusCode ?? 0,
            body,
            headers: r.headers,
          }),
        )
      })
      .on('error', reject)
  })
}

// the Seed server program: serve on PORT, echoing the request path (so a fetch proves method/path parsing + the handler)
// Spawn the built server and KEEP its stderr. With `stdio: 'ignore'` a server that panicked on startup and a
// server that was merely slow produced the identical message, which is the least useful failure a round trip can
// report.
function spawnServer(
  command: string,
  args: string[] = [],
): { proc: ReturnType<typeof spawn>; said: () => string } {
  const proc = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let heard = ''

  proc.stdout?.on('data', (chunk: Buffer) => {
    heard += chunk.toString()
  })
  proc.stderr?.on('data', (chunk: Buffer) => {
    heard += chunk.toString()
  })

  return { proc, said: () => heard.trim().slice(0, 600) }
}

const SERVER = (port: number): string => `load @cluesurf/seed/code/network/server
  find serve

load @cluesurf/seed/code/network/server/response
  find response
  find make-ok
  find with-header

task boot
  like void
  call serve
    code ${port}
    text <127.0.0.1>
    task handler
      take req
      like response
      send back
        call with-header
          call make-ok
            read req/path
          text <x-seed>
          text <ok>
`

async function rustServer(): Promise<void> {
  const name = 'rust: compiled HTTP server echoes the request path'

  if (!have('cargo')) {
    skip++
    console.log(`skip  ${name}  (cargo not installed)`)

    return
  }

  const port = 8771
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-rs-'))
  const program = frontEnd(SERVER(port), 'rust')
  const main = `\nfn main() { boot(); }\n`
  mkdirSync(join(dir, 'src'), { recursive: true })
  const file = join(dir, 'src', 'main.rs')
  writeFileSync(
    file,
    `#![allow(warnings)]\n${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(
      program,
    )}${main}`,
  )

  // the crates the server shim wraps, mirroring deck/seed/code/native/rust/Cargo.toml. `rustc` alone cannot build
  // this any more: the shim is hyper, not a std::net accept loop.
  writeFileSync(
    join(dir, 'Cargo.toml'),
    `[package]
name = "seed-server-roundtrip"
version = "0.1.0"
edition = "2021"

[dependencies]
tokio = { version = "1", features = ["full"] }
hyper = { version = "1", features = ["server", "client", "http1", "http2"] }
hyper-util = { version = "0.1", features = ["tokio", "server", "server-auto", "service"] }
http-body-util = "0.1"
bytes = "1"
tokio-rustls = "0.26"
rustls-pemfile = "2"

[[bin]]
name = "server"
path = "src/main.rs"
`,
  )

  // the shared target directory the gate and task/term/native/rust.sh use, so the crate graph is already built
  const cargoEnv = {
    ...process.env,
    CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target'),
  }

  try {
    execFileSync('cargo', ['build', '--quiet', '--bin', 'server'], {
      cwd: dir,
      stdio: 'pipe',
      env: cargoEnv,
    })
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (cargo error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(0, 600)})`,
    )

    return
  }

  const exe = join(cargoEnv.CARGO_TARGET_DIR, 'debug', 'server')
  const { proc, said } = spawnServer(exe)

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('rust: compiled server returns 200', echo.status, 200)
    ok(
      'rust: response carries the handler-set header',
      echo.headers['x-seed'],
      'ok',
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (request error: ${String(e)})${
        said() ? `\n      the server said: ${said()}` : ''
      }`,
    )
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
    execFileSync('kotlinc', [file, ...nativeFlags('kotlin'), '-include-runtime', '-d', jar], {
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

  // the ktor classes have to be on the RUN classpath too, not just the compile one: `-include-runtime` bundles
  // kotlin-stdlib and nothing else, so `java -jar` alone is `NoClassDefFoundError: io/ktor/server/cio/CIO` at the
  // first line of the server
  const classpath = nativeFlags('kotlin')[1] ?? ''
  const { proc, said } = spawnServer('java', [
    '-classpath',
    classpath ? `${jar}:${classpath}` : jar,
    'ServerKt',
  ])

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('kotlin: compiled server returns 200', echo.status, 200)
    ok(
      'kotlin: response carries the handler-set header',
      echo.headers['x-seed'],
      'ok',
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (request error: ${String(e)})${
        said() ? `\n      the server said: ${said()}` : ''
      }`,
    )
  } finally {
    proc.kill('SIGKILL')
  }
}

async function swiftServer(): Promise<void> {
  const name = 'swift: compiled HTTP server echoes the request path'

  if (!have('swift')) {
    skip++
    console.log(`skip  ${name}  (swift not installed)`)

    return
  }

  const port = 8773
  const dir = mkdtempSync(join(tmpdir(), 'seed-server-sw-'))
  const program = frontEnd(SERVER(port), 'swift')
  // A SwiftPM PACKAGE, not a bare `swiftc -o`. The server shim is Hummingbird now, and a bare swiftc can be given
  // the module search paths (that is what nativeFlags does, and it is enough to TYPECHECK) but not the libraries:
  // producing an executable then fails at the link step with no useful message. SwiftPM does both.
  mkdirSync(join(dir, 'Sources', 'server'), { recursive: true })
  const file = join(dir, 'Sources', 'server', 'main.swift')
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(
      program,
    )}\nboot()\n`,
  )
  writeFileSync(
    join(dir, 'Package.swift'),
    `// swift-tools-version:5.9
// GENERATED by test/compile/server-roundtrip.ts. Mirrors deck/seed/code/native/swift/Package.swift.
import PackageDescription

let package = Package(
    name: "server",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        .package(
            url: "https://github.com/hummingbird-project/hummingbird.git",
            from: "2.0.0"
        ),
    ],
    targets: [
        .executableTarget(
            name: "server",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "_NIOFileSystem", package: "swift-nio"),
                .product(name: "Hummingbird", package: "hummingbird"),
                .product(name: "HummingbirdHTTP2", package: "hummingbird"),
                .product(name: "HummingbirdTLS", package: "hummingbird"),
            ],
            path: "Sources/server"
        )
    ]
)
`,
  )

  // the SwiftPM scratch directory is SHARED between runs, so the swift-nio and Hummingbird graph is resolved and
  // built once rather than once per run (a cold resolve is minutes)
  const scratch = join(tmpdir(), 'term-native', 'swift', 'server-roundtrip')
  const exe = join(scratch, 'debug', 'server')

  try {
    execFileSync(
      'swift',
      [
        'build',
        '--package-path',
        dir,
        '--scratch-path',
        scratch,
        '--product',
        'server',
      ],
      { stdio: 'pipe' },
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (swift build error: ${String(
        (e as { stderr?: Buffer }).stderr ?? e,
      ).slice(-900)})`,
    )

    return
  }

  const { proc, said } = spawnServer(exe)

  try {
    await waitForPort(port)
    const echo = await get(port, '/hello/world?x=1')
    ok(name, echo.body, '/hello/world')
    ok('swift: compiled server returns 200', echo.status, 200)
    ok(
      'swift: response carries the handler-set header',
      echo.headers['x-seed'],
      'ok',
    )
  } catch (e) {
    fail++
    console.log(
      `FAIL  ${name}  (request error: ${String(e)})${
        said() ? `\n      the server said: ${said()}` : ''
      }`,
    )
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
