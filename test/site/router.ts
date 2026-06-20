// site.tree server test: compile the real site.tree HTTP router (request / route / server, `:param` matching,
// dispatch + 404) against the base stdlib, run it, and assert the request lifecycle. Proves the app framework's
// router works end to end on the actual compiler. Run: npx tsx test/site/router.ts

import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@/code/compile/compile'
import { withNativeEnv } from '@/code/compile/native'
import type { Source } from '@/code/compile/load'
import { render } from '@/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const base = join(here, '..', '..', '..', 'base.tree')
const site = join(here, '..', '..', '..', 'site.tree')
// resolve both @cluesurf/base and @cluesurf/site to their on-disk trees
const stdlib = (path: string): Source | undefined => {
  for (const [pkg, root] of [['@cluesurf/base/', base], ['@cluesurf/site/', site]] as const) {
    if (path.startsWith(pkg)) {
      const file = join(root, `${path.slice(pkg.length)}.tree`)
      return existsSync(file) ? { file, text: readFileSync(file, 'utf8') } : undefined
    }
  }
  return undefined
}
const resolve = withNativeEnv('node', stdlib)

let pass = 0
let fail = 0
function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) { pass++; console.log(`ok    ${name}`) }
  else { fail++; console.log(`FAIL  ${name}  (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`) }
}

async function loadProgram(source: string): Promise<Record<string, (...a: Array<unknown>) => unknown>> {
  const result = compile({ file: 'main.tree', text: source }, { resolve })
  if (!result.ok) {
    for (const d of result.diagnostics) console.log(render(d, source.split('\n'), false))
    throw new Error('compile failed')
  }
  const js = transformSync(result.typescript, { loader: 'ts', format: 'esm' }).code
  const dir = mkdtempSync(join(tmpdir(), 'seed-site-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)
  return (await import(pathToFileURL(file).href)) as Record<string, (...a: Array<unknown>) => unknown>
}

// a one-route server (`GET /users/:id`) plus the request lifecycle: matched dispatch, and the 404 fallthrough
const ROUTER = `load @cluesurf/site/code/http/http
  find handle-request
  find route-params
  find request
  find response
  find route
  find server

load @cluesurf/base/code/hash
  find has

task respond
  take req, like request
  like response
  send back
    make response
      bind status, mark 200
      bind body, text <hello user>

task route-status
  take method, like text
  take path, like text
  like number
  save app
    make server
      bind routes
        make list
          make route
            bind method, text <GET>
            bind path, text </users/:id>
            bind handle, read respond
  save result
    call handle-request
      read app
      make request
        bind method, read method
        bind path, read path
        bind body, text <>
  send back
    read result/status

task has-param
  take name, like text
  like boolean
  save params
    call route-params
      make route
        bind method, text <GET>
        bind path, text </users/:id>
        bind handle, read respond
      make request
        bind method, text <GET>
        bind path, text </users/42>
        bind body, text <>
  send back
    call has
      read params
      read name
`

async function main(): Promise<void> {
  const r = await loadProgram(ROUTER)
  expect('site/router: GET /users/42 matches the :id route (200)', r.routeStatus!('GET', '/users/42'), 200)
  expect('site/router: GET /users/7 also matches the param route (200)', r.routeStatus!('GET', '/users/7'), 200)
  expect('site/router: a non-matching path falls through to 404', r.routeStatus!('GET', '/posts/1'), 404)
  expect('site/router: a wrong method does not match (404)', r.routeStatus!('POST', '/users/42'), 404)
  expect('site/router: route-params extracts the :id parameter', r.hasParam!('id'), true)
  expect('site/router: route-params has no param for an unknown name', r.hasParam!('slug'), false)

  console.log(`\nsite/router: ${pass} pass, ${fail} fail  (the real site.tree router over the base stdlib)`)
  if (fail > 0) process.exit(1)
}

main()
