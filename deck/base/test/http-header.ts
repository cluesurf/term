// Headers actually reach the server.
//
//   pnpm exec tsx test/http-header.ts
//
// Asserted against a stub that echoes what it was sent, because the only way
// to know a header arrived is to have something receive it. The shim is
// exercised directly rather than through the stdlib, so this tests the code
// that was changed and nothing else.
//
// node only. The rust, swift and kotlin runtimes carry the same change,
// written to match, and are NOT exercised here.
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

// the shim under test, loaded from source
const source = readFileSync('code/native/node/runtime/http.ts', 'utf8')
const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const http = new Function(`${js}; return http`)() as {
  request: (
    method: string,
    url: string,
    body: string,
    header?: Map<string, string>,
  ) => Promise<{ status: number; body: string }>
}

const seen: Array<Record<string, string | string[] | undefined>> = []

const server = createServer((req, res) => {
  seen.push(req.headers)
  let body = ''
  req.on('data', c => (body += c))
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ got: body }))
  })
})

await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
const port = (server.address() as { port: number }).port
const url = `http://127.0.0.1:${port}/`

let pass = 0
let fail = 0

const ok = (what: string) => {
  console.log(`  ok    ${what}`)
  pass += 1
}

const no = (what: string) => {
  console.log(`  FAIL  ${what}`)
  fail += 1
}

// 1. a header is sent
const one = await http.request(
  'POST',
  url,
  '{"a":1}',
  new Map([['authorization', 'Bearer probe-token']]),
)

seen[0]?.authorization === 'Bearer probe-token'
  ? ok('the header reached the server')
  : no(`authorization was ${String(seen[0]?.authorization)}`)

one.status === 200 ? ok('the response came back') : no(`status ${one.status}`)
// the stub echoes the body inside a JSON field, so it comes back escaped
const echoed = (JSON.parse(one.body) as { got: string }).got

echoed === '{"a":1}' ? ok('the body was sent too') : no(`body was ${echoed}`)

// 2. several headers
await http.request(
  'POST',
  url,
  '{}',
  new Map([
    ['authorization', 'Bearer two'],
    ['content-type', 'application/json'],
  ]),
)

seen[1]?.['content-type'] === 'application/json'
  ? ok('a second header reached the server')
  : no('content-type missing')

// 3. NO headers, which is what every existing caller passes
await http.request('GET', url, '')

seen[2]?.authorization === undefined
  ? ok('no header is sent when none is given')
  : no('a header appeared from nowhere')

// 4. an empty map behaves as none
await http.request('GET', url, '', new Map())

seen[3]?.authorization === undefined
  ? ok('an empty map sends no header')
  : no('an empty map sent something')

server.close()

console.log('')
console.log(fail === 0 ? '  every header check passed' : `  ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
