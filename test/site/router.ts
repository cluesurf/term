// site.tree server test: compile the real site.tree HTTP router (request / route / server, `:param` matching,
// dispatch + 404) against the base stdlib, run it, and assert the request lifecycle. Proves the app framework's
// router works end to end on the actual compiler. Run: npx tsx test/site/router.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { render } from '@term/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const SEED = resolvePath(here, '..', '..')
// resolve through the seed package manager: linked @cluesurf/* + the abstract http transport rewritten to the node impl
const resolve = projectResolver(SEED, 'node')

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
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

async function loadProgram(
  source: string,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve },
  )

  if (!result.ok) {
    for (const d of result.diagnostics)
      {console.log(render(d, source.split('\n'), false))}

    throw new Error('compile failed')
  }

  const js = transformSync(result.typescript, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'seed-site-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: unknown[]) => unknown
  >
}

// a one-route server (`GET /users/:id`) built with the trie router (`route-server`) plus the request lifecycle:
// matched dispatch, the 404 fallthrough, and param extraction observed *through* the handler (the real surface)
const ROUTER = `load @cluesurf/site/code/http/http
  find handle-request
  find route-server
  find request
  find response
  find route
  find server

load @cluesurf/seed/code/hash
  find get

load @cluesurf/seed/code/maybe
  find unwrap-or

task respond
  take request, like request
  take params, like hash
  like response
  send back
    make response
      bind status, code 200
      bind body
        call unwrap-or
          call get
            read params
            text <id>
          text <none>

task build-app
  like server
  send back
    call route-server
      make list
        make route
          bind method, text <GET>
          bind path, text </users/:id>
          bind handle, read respond

task route-status
  take method, like text
  take path, like text
  like number
  save result
    call handle-request
      call build-app
      make request
        bind method, read method
        bind path, read path
        bind body, text <>
  send back
    read result/status

task route-param
  take method, like text
  take path, like text
  like text
  save result
    call handle-request
      call build-app
      make request
        bind method, read method
        bind path, read path
        bind body, text <>
  send back
    read result/body
`

async function main(): Promise<void> {
  const r = await loadProgram(ROUTER)
  expect(
    'site/router: GET /users/42 matches the :id route (200)',
    r.routeStatus('GET', '/users/42'),
    200,
  )
  expect(
    'site/router: GET /users/7 also matches the param route (200)',
    r.routeStatus('GET', '/users/7'),
    200,
  )
  expect(
    'site/router: a non-matching path falls through to 404',
    r.routeStatus('GET', '/posts/1'),
    404,
  )
  expect(
    'site/router: a wrong method does not match (404)',
    r.routeStatus('POST', '/users/42'),
    404,
  )
  expect(
    'site/router: the :id param is bound and reaches the handler',
    r.routeParam('GET', '/users/42'),
    '42',
  )
  expect(
    'site/router: a different :id value binds correctly',
    r.routeParam('GET', '/users/7'),
    '7',
  )

  console.log(
    `\nsite/router: ${pass} pass, ${fail} fail  (the real site.tree trie router over the base stdlib)`,
  )

  if (fail > 0) {process.exit(1)}
}

main()
