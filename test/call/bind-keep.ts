// `term bind` keeps a login that works (deck/call/code/bind.ts `keepsLogin`): against a stand-in for term.surf, a
// good saved token is reported and NO login starts, a token term.surf refuses starts one, an API that cannot answer
// keeps the token, and `--again` starts one whatever the token. A login that starts asks `create!`, which the stand-in
// answers with no URL, so no browser ever opens here.
// Run: npx tsx test/call/bind-keep.ts
import { execFile } from 'node:child_process'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LINE = join(import.meta.dirname, '..', '..', 'host', 'line.js')

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

// how term.surf answers `select!` for each token, and every `create!` it was asked for
let selectStatus = 200
const asked: string[] = []

const server = http.createServer((request, response) => {
  asked.push(request.url ?? '')

  if (request.url === '/sessions/terminal/select!') {
    if (selectStatus !== 200) {
      response.writeHead(selectStatus, { 'content-type': 'application/json' }).end(JSON.stringify({ note: `refused, ${selectStatus}` }))

      return
    }

    const good = request.headers.authorization === 'Bearer ws-good'

    response
      .writeHead(good ? 200 : 401, { 'content-type': 'application/json' })
      .end(JSON.stringify(good ? { result: { name: 'term bind · laptop', expires_at: '2027-10-05T00:00:00.000Z', user: { slug: 'alice' } } } : { note: 'This token is unknown, revoked or expired' }))

    return
  }

  // a login that starts gets no URL, so the run ends before any browser
  response.writeHead(503, { 'content-type': 'application/json' }).end(JSON.stringify({ note: 'Terminal login is not configured' }))
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))

const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

function bind(token: string | undefined, args: string[] = []): Promise<string> {
  const home = mkdtempSync(join(tmpdir(), 'term-bind-'))

  if (token) {
    mkdirSync(join(home, '.base', '@term', 'code'), { recursive: true })
    writeFileSync(join(home, '.base', '@term', 'code', 'auth'), `${token}\n`)
  }

  asked.length = 0

  return new Promise(resolve =>
    execFile(
      process.execPath,
      [LINE, 'bind', ...args, '--plain', '--color', 'never'],
      { env: { ...process.env, HOME: home, TERM_INDEX_URL: base, TERM_TOKEN: '' }, encoding: 'utf8' },
      (_error, stdout, stderr) => resolve(`${stdout}${stderr}`),
    ),
  )
}

const kept = await bind('ws-good')
ok('a working token is reported, and no login starts', /logged in as @alice/i.test(kept) && !asked.includes('/sessions/terminal/create!'), kept)

const refused = await bind('ws-revoked')
ok('a token term.surf refuses starts a login', /no longer works/.test(refused) && asked.includes('/sessions/terminal/create!'), refused)

const none = await bind(undefined)
ok('no saved token starts a login', !asked.includes('/sessions/terminal/select!') && asked.includes('/sessions/terminal/create!'), none)

selectStatus = 404
const unchecked = await bind('ws-good')
ok('an API that cannot answer keeps the token, and no login starts', /could not be checked/.test(unchecked) && !asked.includes('/sessions/terminal/create!'), unchecked)
selectStatus = 200

const again = await bind('ws-good', ['--again'])
ok('--again starts a login whatever the token', !asked.includes('/sessions/terminal/select!') && asked.includes('/sessions/terminal/create!'), again)

server.close()
console.log(`\nbind-keep: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
