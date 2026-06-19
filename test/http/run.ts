// Backend router test: compile the `.tree` http runtime + a demo API through the seed compiler to JS, run it, and
// confirm requests are matched to routes (including `:param` paths) and dispatched, with 404 for no match. The
// matcher + dispatch are the uniform "ours" layer; `serve` (transport) is native-delegated. Run: npx tsx test/http/run.ts

import { compile } from '@/code/compile/compile'
import type { Source } from '@/code/compile/load'
import { transform } from 'esbuild'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}`) } else { fail++; console.log(`FAIL  ${name}  ${info}`) }
}

const DECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const tryFile = (b: string): Source | undefined => {
  for (const c of [b + '.tree', path.join(b, 'base.tree')]) if (fs.existsSync(c) && fs.statSync(c).isFile()) return { file: c, text: fs.readFileSync(c, 'utf8') }
  return undefined
}
function resolve(imp: string, from: string): Source | undefined {
  if (imp.startsWith('@cluesurf/base/code/')) return tryFile(path.join(DECK, 'base.tree/code', imp.slice(20)))
  if (imp.startsWith('@cluesurf/site/code/')) return tryFile(path.join(DECK, 'site.tree/code', imp.slice(20)))
  if (imp.startsWith('./') || imp.startsWith('../')) return tryFile(path.resolve(path.dirname(from), imp))
  return undefined
}

async function main(): Promise<void> {
  const entry = path.join(DECK, 'site.tree/code/test/site/api.tree')
  const result = compile({ file: entry, text: fs.readFileSync(entry, 'utf8') }, { resolve })
  ok('http runtime + API compiles to JS', result.ok, result.ok ? '' : JSON.stringify(result.diagnostics.slice(0, 4)))
  if (!result.ok) { console.log(`\nhttp: ${pass} pass, ${fail} fail`); return }

  const js = (await transform(result.typescript, { loader: 'ts', format: 'esm' })).code
  const file = path.join(os.tmpdir(), `seed-http-${process.pid}.mjs`)
  fs.writeFileSync(file, js)
  try {
    const M = (await import(file)) as {
      makeApi: () => unknown
      handleRequest: (server: unknown, request: { method: string; path: string; body: string }) => { status: number; body: string }
    }
    const server = M.makeApi()
    const health = M.handleRequest(server, { method: 'GET', path: '/health', body: '' })
    ok('exact route dispatches', health.status === 200 && health.body === 'ok', JSON.stringify(health))
    const user = M.handleRequest(server, { method: 'GET', path: '/users/42', body: '' })
    ok(':param route matches and dispatches', user.status === 200 && user.body === 'user', JSON.stringify(user))
    const missing = M.handleRequest(server, { method: 'GET', path: '/nope', body: '' })
    ok('unmatched path returns 404', missing.status === 404, JSON.stringify(missing))
    const wrongMethod = M.handleRequest(server, { method: 'POST', path: '/health', body: '' })
    ok('method mismatch returns 404', wrongMethod.status === 404, JSON.stringify(wrongMethod))
  } finally {
    fs.rmSync(file, { force: true })
  }

  console.log(`\nhttp: ${pass} pass, ${fail} fail`)
}

void main()
