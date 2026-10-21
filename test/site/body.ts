// Request bodies, live (term-site-framework-0007): @term/site/http/body reads an `application/x-www-form-urlencoded`
// or JSON body into Term data, the app fills its own form from it (`call fill / ... / like <form>`), answers JSON
// through one escaping writer, and redirects after a post. A body that does not fit is a mismatch, which the funnel
// (`expose`, http/tell.tree) answers 400. Compiles a small app against the real stdlib, @term/host and @term/site.
// Run: npx tsx test/site/body.ts

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'
import { nativePrelude } from '@term/make/code/compile/native'

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

const TERM = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

const APP = `load @term/site/code/http/http
  find request
  find response

load @term/site/code/http/body
  find read-body
  find redirect
  find answer-json

load @term/site/code/http/tell
  find expose

load @term/host/code/base
  find data

form note-input
  link title, like text
  link body, like text

# POST /notes as an API: the note back as JSON, 201
task post-note
  take request, like request
  like response
  save note
    call fill
      call read-body(read request)
      like note-input
  send back
    call answer-json
      call melt
        read note
        like note-input
      code 201

# POST /notes from a page: fill, then 303 to the list
task submit-note
  take request, like request
  like response
  save note
    call fill
      call read-body(read request)
      like note-input
  send back
    call redirect
      text </notes>
`

type Response = { status: number; body: string; headers: Map<string, string> }

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'term-body-'))
  fs.mkdirSync(path.join(root, 'link/@term'), { recursive: true })
  fs.mkdirSync(path.join(root, 'code'), { recursive: true })
  fs.symlinkSync(path.join(TERM, 'deck/base'), path.join(root, 'link/@term/base'))
  fs.symlinkSync(path.join(TERM, 'deck/host'), path.join(root, 'link/@term/host'))
  fs.symlinkSync(path.join(TERM, 'deck/site'), path.join(root, 'link/@term/site'))
  fs.writeFileSync(path.join(root, 'deck.tree'), 'deck @probe/body\n  code <0.0.0>\n')
  const entry = path.join(root, 'code/app.tree')
  fs.writeFileSync(entry, APP)

  const result = compile(
    { file: entry, text: APP },
    { resolve: projectResolver(root, 'node'), deckOf: projectDeckOf(), roll: true, treeShake: false },
  )

  ok('the app compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => `${d.file?.split('/').pop()}:${d.span?.start?.line}: ${d.message}`).join(' | '))

  if (!result.ok) {
    console.log(`\nbody: ${pass} pass, ${fail} fail`)
    process.exit(1)
  }

  const prelude = nativePrelude(result.program, 'node', (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined))
  const js = (await transform(`${prelude}\n${result.typescript}`, { loader: 'ts', format: 'esm' })).code
  const file = path.join(root, 'app.mjs')
  fs.writeFileSync(file, js)

  const M = (await import(pathToFileURL(file).href)) as {
    wakeHive: () => void
    postNote: (r: unknown) => Response
    submitNote: (r: unknown) => Response
    expose: (e: unknown) => Response
  }

  M.wakeHive()

  const request = (type: string, body: string) => ({
    method: 'POST',
    path: '/notes',
    body,
    headers: new Map([['content-type', type]]),
    query: new Map(),
  })

  // the funnel's answer for whatever the handler raised, or the handler's own
  const answer = (run: () => Response): Response => {
    try {
      return run()
    } catch (e) {
      return M.expose(e)
    }
  }

  const FORM = 'application/x-www-form-urlencoded'
  const JSON_TYPE = 'application/json; charset=utf-8'
  const title = 'a "quoted" & <b>bold</b> été'
  const body = 'line one\nline two\r\n\'single\' 100% + more'
  const want = { title, body }

  // hostile values through the urlencoded body: `+` for a space, everything else percent-encoded as a browser does
  const encoded = `title=${encodeURIComponent(title).replace(/%20/g, '+')}&body=${encodeURIComponent(body).replace(/%20/g, '+')}`
  const viaForm = answer(() => M.postNote(request(FORM, encoded)))
  ok('a urlencoded post answers 201', viaForm.status === 201, `${viaForm.status} ${viaForm.body}`)
  ok('the answer is JSON by its header', String(viaForm.headers.get('content-type')).startsWith('application/json'), String(viaForm.headers.get('content-type')))
  let parsedForm: unknown

  try {
    parsedForm = JSON.parse(viaForm.body)
  } catch {
    parsedForm = undefined
  }

  ok('quotes, newlines, ampersands and markup round trip through a form body', JSON.stringify(parsedForm) === JSON.stringify(want), viaForm.body)

  const viaJson = answer(() => M.postNote(request(JSON_TYPE, JSON.stringify(want))))
  ok('the same values round trip through a JSON body', viaJson.status === 201 && viaJson.body === viaForm.body, `${viaJson.status} ${viaJson.body}`)

  // a name or value with no `=`, an empty pair, and a `%` not followed by two hex digits stay as WHATWG reads them
  const loose = answer(() => M.postNote(request(FORM, 'title=50%25+off+%zz&&body=')))
  ok('an empty pair is skipped and a bare `%` stays', loose.status === 201 && JSON.parse(loose.body).title === '50% off %zz' && JSON.parse(loose.body).body === '', loose.body)

  const moved = answer(() => M.submitNote(request(FORM, encoded)))
  ok('redirect after post: 303 to the list', moved.status === 303 && moved.headers.get('location') === '/notes', `${moved.status} ${moved.headers.get('location')}`)

  const missing = answer(() => M.postNote(request(FORM, 'title=only')))
  ok('a body missing a field is a mismatch, answered 400', missing.status === 400 && JSON.parse(missing.body).case === 'mismatch', `${missing.status} ${missing.body}`)

  const extra = answer(() => M.postNote(request(FORM, `${encoded}&admin=true`)))
  ok('a body with a field the form lacks is a mismatch, answered 400', extra.status === 400, `${extra.status} ${extra.body}`)

  const broken = answer(() => M.postNote(request(JSON_TYPE, '{"title": "x", ')))
  ok('a malformed JSON body is a mismatch, answered 400', broken.status === 400 && JSON.parse(broken.body).case === 'mismatch', `${broken.status} ${broken.body}`)

  const wrongKind = answer(() => M.postNote(request(JSON_TYPE, '{"title": 1, "body": "x"}')))
  ok('a JSON field of the wrong kind is a mismatch, answered 400', wrongKind.status === 400, `${wrongKind.status} ${wrongKind.body}`)

  const plain = answer(() => M.postNote(request('text/plain', 'title=x&body=y')))
  ok('a body of another type is an exclusion, answered 415', plain.status === 415 && JSON.parse(plain.body).case === 'exclusion', `${plain.status} ${plain.body}`)

  console.log(`\nbody: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
