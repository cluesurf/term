// The WHATWG URL corpus (web-platform-tests commit c48d58747e1f211527fb695fd60548a997fae617, vendored under
// test/stdlib/url/) held against base/code/url.tree on every backend. spec: note/project/term/decisions-2026-10/url/spec.md
// section 4.2.
//
// The cases go to ONE case file, every field hex-encoded as UTF-8 (the inputs hold tabs, newlines and controls on
// purpose), and ONE Term program per backend reads that file, parses each case and prints one record per case with each
// getter hex-encoded. Cases are never inlined into the program (the Kotlin method size limit).
//
//   case file   record `;` field `|`:  <href>|<base>          (a base of "" is none)
//   answer      record `;` field `|`:  <status>|<href>|<origin>|<scheme>|<username>|<password>|<host>|<port>|<path>|<query>|<fragment>
//               status 0 parsed, 1 raised `mismatch`, 2 raised `failure`. The getters are hex, empty when failed
//
// toascii.json and IdnaTestV2.json hold {input, output}: the input is a domain, so the case parses
// `https://<input>/x` and compares the host, a null output meaning failure (as WPT's toascii.window.js does).
//
// The ratchet is test/stdlib/url/known.json: per backend, per corpus file, the case indexes still failing. A new
// failure fails the suite, and a listed case that now passes fails it too until it is removed. A backend whose build
// fails is recorded as {"build_failure": "<why>"}. The target is an empty list.
//
// Run: sh tmp/dec-tsx.sh test/stdlib/url.ts   (URL_ONLY=typescript|rust|swift|kotlin runs one backend)
//      URL_WRITE_KNOWN=1 writes known.json from the run, and refuses when the file exists

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from '../compile/shared/run-on'

// `want` is the getters in the order the answer record carries them (href, origin, scheme, username, password, host,
// port, path, query, fragment), null for one the corpus does not state
type Case = { file: string; at: number; href: string; base: string; failure: boolean; want: (string | null)[] }
type Known = Record<string, Record<string, number[]> | { build_failure: string }>

const here = join(process.cwd(), 'test', 'stdlib', 'url')
const knownPath = join(here, 'known.json')
const FILES = [
  { name: 'urltestdata', file: 'urltestdata.json' },
  { name: 'toascii', file: 'toascii.json' },
  { name: 'idna', file: 'IdnaTestV2.json' },
]

const hex = (text: string): string => Buffer.from(text, 'utf8').toString('hex')
const unhex = (text: string): string => Buffer.from(text, 'hex').toString('utf8')

// the cases, each with the getters url.tree exposes today: scheme, host, port, path, query, fragment
function load(): Case[] {
  const cases: Case[] = []

  for (const { name, file } of FILES) {
    const entries = (JSON.parse(readFileSync(join(here, file), 'utf8')) as unknown[]).filter(entry => typeof entry !== 'string') as Record<string, any>[]

    entries.forEach((entry, at) => {
      if (name === 'urltestdata') {
        cases.push({
          file: name,
          at,
          href: entry.input,
          base: entry.base ?? '',
          failure: entry.failure === true,
          want: entry.failure
            ? []
            : [
                entry.href,
                entry.origin ?? null,
                entry.protocol.slice(0, -1),
                entry.username,
                entry.password,
                entry.hostname,
                entry.port,
                entry.pathname,
                entry.search.slice(1),
                entry.hash.slice(1),
              ],
        })
      } else {
        // only the host is asked: every other getter of `https://<domain>/x` is fixed by the scheme and the path
        cases.push({
          file: name,
          at,
          href: `https://${entry.input}/x`,
          base: '',
          failure: entry.output === null,
          want: entry.output === null ? [] : [null, null, 'https', '', '', entry.output, '', '/x', '', ''],
        })
      }
    })
  }

  return cases
}

const literal = (text: string): string => [...text].map(c => (c === '<' || c === '>' || c === '{' || c === '}' || c === '\\' ? `\\${c}` : c)).join('')

const program = (caseFile: string): string => `load @term/base/url
  find make-url
  find href, name serialize
  find origin
  find url

load @term/base/exception
  find mismatch

load @term/base/file
  find read, name read-case-file

load @term/base/text
  find split

load @term/base/text/hex
  find encode-hex
  find decode-hex

load @term/base/list
  find list
  find get
  find push
  find join

# one parsed address as its getters, hex-encoded and joined with the status 0
task describe
  take address, like url
  like text
  save parts, make list
  push(parts, <0>)
  push(parts, encode-hex(serialize(address)))
  push(parts, encode-hex(origin(address)))
  push(parts, encode-hex(address/scheme))
  push(parts, encode-hex(address/username))
  push(parts, encode-hex(address/password))
  push(parts, encode-hex(address/host))
  push(parts, encode-hex(address/port))
  push(parts, encode-hex(address/path))
  push(parts, encode-hex(address/query))
  push(parts, encode-hex(address/fragment))
  back join(parts, <|>)

task parse-based
  take href, like text
  take base, like text
  like text
  fork
    mark unsafe
    back describe(make-url(href, base))
  halt take
    take problem
    sift problem
      case mismatch
        back <1|||||||||>
      case failure
        back <2|||||||||>

task parse-record
  take record, like text
  like text
  save fields, split(record, <|>)
  back parse-based(decode-hex(get(fields, 0)), decode-hex(get(fields, 1)))

task run
  mark async
  like text
  save data, read-case-file(<${literal(caseFile)}>)
  save records, split(data, <;>)
  save out, make list
  walk list, read records
    hook next
      take site, name record
      push(out, parse-record(record))
  back join(out, <;>)
`

// the case indexes a backend got wrong, per corpus file
function grade(cases: Case[], answer: string): Record<string, number[]> {
  const records = answer.split(';')
  const wrong: Record<string, number[]> = Object.fromEntries(FILES.map(f => [f.name, [] as number[]]))
  let shown = 0

  cases.forEach((one, index) => {
    const got = (records[index] ?? '').split('|')
    const status = got[0] ?? ''
    const fields = got.slice(1).map(unhex)
    const good = one.failure ? status === '1' || status === '2' : status === '0' && one.want.every((value, i) => value === null || fields[i] === value)

    if (!good) {
      wrong[one.file]!.push(one.at)

      if (shown < Number(process.env.URL_SHOW ?? 0)) {
        shown++
        console.log(`  ${one.file}[${one.at}] ${JSON.stringify(one.href)} base ${JSON.stringify(one.base)}\n    got  ${status} ${JSON.stringify(fields)}\n    want ${one.failure ? 'failure' : JSON.stringify(one.want)}`)
      }
    }
  })

  return wrong
}

const cases = load()
const total = Object.fromEntries(FILES.map(f => [f.name, cases.filter(one => one.file === f.name).length]))
const dir = mkdtempSync(join(tmpdir(), 'term-url-'))
const caseFile = join(dir, 'cases.txt')
writeFileSync(caseFile, cases.map(one => `${hex(one.href)}|${hex(one.base)}`).join(';'))

const only = process.env.URL_ONLY ?? ''
const known: Known = existsSync(knownPath) ? JSON.parse(readFileSync(knownPath, 'utf8')) : {}
const found: Known = {}
let bad = 0

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: program(caseFile), resolve: env => projectResolver(process.cwd(), env), dir, name: 'url' })

  if (ran.form === 'skipped') {
    console.log(`${backend} skipped: ${ran.reason}`)
    continue
  }

  if (ran.form === 'failed') {
    found[backend] = { build_failure: `${ran.stage}: ${ran.reason}` }
    console.log(`${backend} ${ran.stage} failed: ${ran.reason}`)
    const before = known[backend]

    if (!before || !('build_failure' in before)) {
      bad++
      console.log(`FAIL  ${backend}: a build failure that known.json does not list`)
    }

    continue
  }

  const wrong = grade(cases, ran.output)
  found[backend] = wrong

  for (const { name } of FILES) {
    console.log(`${backend} ${name} ${total[name]! - wrong[name]!.length} of ${total[name]}`)
  }

  const before = known[backend]

  if (Object.keys(known).length > 0) {
    for (const { name } of FILES) {
      const listed = new Set(before && !('build_failure' in before) ? (before[name] ?? []) : [])
      const now = new Set(wrong[name])
      const fresh = [...now].filter(at => !listed.has(at))
      const gone = [...listed].filter(at => !now.has(at))

      if (fresh.length > 0) {
        bad++
        console.log(`FAIL  ${backend} ${name}: new failures ${fresh.slice(0, 20).join(',')}${fresh.length > 20 ? ` (${fresh.length})` : ''}`)
      }

      if (gone.length > 0) {
        bad++
        console.log(`FAIL  ${backend} ${name}: listed in known.json and now passing, remove ${gone.slice(0, 20).join(',')}${gone.length > 20 ? ` (${gone.length})` : ''}`)
      }
    }
  }
}

if (process.env.URL_WRITE_KNOWN === '1') {
  // an existing known.json is replaced only on purpose (URL_REPLACE_KNOWN=1), by the item whose parser changed what a case does
  if (existsSync(knownPath) && process.env.URL_REPLACE_KNOWN !== '1') {
    console.log(`refused: ${knownPath} exists, known.json only shrinks and is edited by the item that fixes a case (URL_REPLACE_KNOWN=1 replaces it)`)
    process.exit(1)
  }

  writeFileSync(knownPath, `${JSON.stringify(found, null, 2)}\n`)
  console.log(`wrote ${knownPath}`)
}

const emptied = Object.values(found).every(entry => !('build_failure' in entry) && Object.values(entry).every(list => list.length === 0))
console.log(`\nurl: ${bad} ratchet failure(s), known.json ${Object.keys(known).length === 0 ? 'absent' : 'present'}, run ${emptied ? 'clean' : 'has failing cases'}`)

if (bad > 0) {
  process.exit(1)
}
