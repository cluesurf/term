// Backend router test: compile the `.tree` http runtime + a demo API through the seed compiler to JS, run it, and
// confirm requests are matched to routes (including `:param` paths) and dispatched, with 404 for no match. The
// matcher + dispatch are the uniform "ours" layer; `serve` (transport) is native-delegated. Run: npx tsx test/http/run.ts

import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { transform } from 'esbuild'
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
const DECK = path.resolve(SEED, '..')
// resolve through the seed package manager: linked @cluesurf/* + the abstract http transport rewritten to the node
// impl by the `node` env.
const resolve = projectResolver(SEED, 'node')

async function main(): Promise<void> {
  const entry = path.join(
    DECK,
    'seed/deck/site/code/test/site/api.tree',
  )
  const result = compile(
    { file: entry, text: fs.readFileSync(entry, 'utf8') },
    { resolve },
  )
  ok(
    'http runtime + API compiles to JS',
    result.ok,
    result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)),
  )
  if (!result.ok) {
    console.log(`\nhttp: ${pass} pass, ${fail} fail`)
    return
  }

  const js = (
    await transform(result.typescript, { loader: 'ts', format: 'esm' })
  ).code
  const file = path.join(os.tmpdir(), `seed-http-${process.pid}.mjs`)
  fs.writeFileSync(file, js)
  try {
    const M = (await import(file)) as {
      makeApi: () => unknown
      handleRequest: (
        server: unknown,
        request: { method: string; path: string; body: string },
      ) => { status: number; body: string }
    }
    const server = M.makeApi()
    const health = M.handleRequest(server, {
      method: 'GET',
      path: '/health',
      body: '',
    })
    ok(
      'exact route dispatches',
      health.status === 200 && health.body === 'ok',
      JSON.stringify(health),
    )
    const user = M.handleRequest(server, {
      method: 'GET',
      path: '/users/42',
      body: '',
    })
    ok(
      ':param route binds the param',
      user.status === 200 && user.body === '42',
      JSON.stringify(user),
    )
    const user2 = M.handleRequest(server, {
      method: 'GET',
      path: '/users/abc',
      body: '',
    })
    ok(
      ':param matches a different value',
      user2.body === 'abc',
      JSON.stringify(user2),
    )
    const files = M.handleRequest(server, {
      method: 'GET',
      path: '/files/a/b/c.txt',
      body: '',
    })
    ok(
      '** catch-all binds the joined rest',
      files.status === 200 && files.body === 'a/b/c.txt',
      JSON.stringify(files),
    )
    const missing = M.handleRequest(server, {
      method: 'GET',
      path: '/nope',
      body: '',
    })
    ok(
      'unmatched path returns 404',
      missing.status === 404,
      JSON.stringify(missing),
    )
    const wrongMethod = M.handleRequest(server, {
      method: 'POST',
      path: '/health',
      body: '',
    })
    ok(
      'method mismatch returns 404',
      wrongMethod.status === 404,
      JSON.stringify(wrongMethod),
    )
    // static must win over a same-depth :param sibling (specificity)
    ok(
      'static beats param at same depth',
      M.handleRequest(server, {
        method: 'GET',
        path: '/health',
        body: '',
      }).body === 'ok',
    )
  } finally {
    fs.rmSync(file, { force: true })
  }

  console.log(`\nhttp: ${pass} pass, ${fail} fail`)
}

void main()
