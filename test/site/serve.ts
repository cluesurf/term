// Live hono-transport test: compile a `.tree` backend that builds a trie-routed API and `serve`s it, prepend the hono
// runtime shim (what the native-env prelude does), bundle with hono left external, start it on a port, and fetch it over
// real HTTP. Proves hono owns the socket while the uniform `handle-request` does the matching (static + `:param`).
// Run: npx tsx test/site/serve.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { nativePrelude } from '@cluesurf/make/code/compile/native'
import { build } from 'esbuild'
import * as fs from 'node:fs'
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

const DECK = path.resolve(SEED, '..')
const resolve = projectResolver(SEED, 'node')
const PORT = 38561

async function main(): Promise<void> {
  const entry = path.join(DECK, 'seed/deck/site/test/site/serve.tree')
  const result = compile(
    { file: entry, text: fs.readFileSync(entry, 'utf8') },
    { resolve },
  )

  ok(
    'serve app compiles',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )

  if (!result.ok) {
    console.log(`\nserve: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  // userland never imports hono: the compiled output references the `httpServer` namespace from the prelude shim
  ok(
    'compiled output has no hono import',
    !/from ['"]hono['"]/.test(result.typescript),
  )

  // the native-env prelude (the same one `seed boot` prepends): nativePrelude auto-discovers the <global:transport>
  // shim next to the module that docks it. Then bundle with hono left external (from node_modules).
  const readRuntime = (p: string): string | undefined =>
    fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined

  const prelude = nativePrelude(result.program, 'node', readRuntime)
  const tmp = path.join(SEED, 'test', 'tmp')
  fs.mkdirSync(tmp, { recursive: true })

  const dir = fs.mkdtempSync(path.join(tmp, 'serve-'))
  fs.writeFileSync(
    path.join(dir, 'app.ts'),
    `${prelude}\n${result.typescript}`,
  )

  const bundled = await build({
    entryPoints: [path.join(dir, 'app.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['hono', '@hono/node-server'],
    write: false,
  })

  const file = path.join(dir, 'app.mjs')
  fs.writeFileSync(file, bundled.outputFiles[0].text)

  let M: { start: (port: number) => void }

  try {
    M = await import(file)
    M.start(PORT)
    await new Promise(r => setTimeout(r, 250)) // let the socket bind
    ok('hono server starts', true)
  } catch (e) {
    ok('hono server starts', false, String((e as Error).message))
    console.log(
      `\nserve: ${pass} pass, ${fail} fail  (is hono installed?)`,
    )
    fs.rmSync(dir, { recursive: true, force: true })
    process.exit(1)
  }

  const fetchText = async (
    p: string,
  ): Promise<{ status: number; body: string }> => {
    const r = await fetch(`http://localhost:${PORT}${p}`)

    return { status: r.status, body: await r.text() }
  }

  const health = await fetchText('/health')
  ok(
    'static /health dispatches (200 ok)',
    health.status === 200 && health.body === 'ok',
    JSON.stringify(health),
  )

  const u42 = await fetchText('/users/42')
  ok(
    ':param /users/42 binds id=42',
    u42.status === 200 && u42.body === '42',
    JSON.stringify(u42),
  )

  const u7 = await fetchText('/users/7')
  ok(
    ':param /users/7 binds id=7',
    u7.status === 200 && u7.body === '7',
    JSON.stringify(u7),
  )

  const miss = await fetchText('/nope')
  ok(
    'unmatched path returns 404',
    miss.status === 404,
    JSON.stringify(miss),
  )

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\nserve: ${pass} pass, ${fail} fail`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
