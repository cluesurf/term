// Numbers and money by language (decision D7, term/decisions-2026-10/locale): the ONE formatter written in Term
// (deck/base/code/text/format.tree over the generated CLDR 48.0 module), held on every backend to node's
// `Intl.NumberFormat` (roundingMode halfEven, CLDR 48.0), frozen case by case into test/stdlib/text-format/reference.tsv.
// ONE Term program per backend READS test/stdlib/text-format/cases.tsv (the cases are never inline) and prints a line per
// case, and the lines must equal the reference's, except the cases test/stdlib/text-format/known.json names.
//
// known.json is a ratchet: a case that fails and is not listed fails the suite, and a listed case that now passes fails it
// until it is removed, so the list only shrinks. Each class carries its cause, and a `Diverges:` line at the fold.
//
// Prints `<backend> <passed> of <cases>` and the size of known.json per backend.
// Run: sh /Users/lancepollard/base/crew/cluesurf/deck/term/deck/term/tmp/dec-tsx.sh test/stdlib/text-format.ts
//      FORMAT_ONLY=typescript|rust|swift|kotlin runs one backend.
// Write known.json once, from a run: ... test/stdlib/text-format.ts --known   (refuses to overwrite a file that exists)

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn } from '../compile/shared/run-on'

const HERE = resolve(process.cwd(), 'test/stdlib/text-format')
const KNOWN_FILE = join(HERE, 'known.json')
const BACKENDS = ['typescript', 'rust', 'swift', 'kotlin'] as const

type Known = { class: Record<string, string>; case: Record<string, Record<string, string>> }

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

const lines = readFileSync(join(HERE, 'reference.tsv'), 'utf8').split('\n').filter(line => line !== '' && !line.startsWith('#'))
const refs = lines.map(line => {
  const parts = line.split('\t')
  const width = parts[0] === 'n' ? 5 : 4

  return { kind: parts[0]!, locale: parts[1]!, key: parts.slice(0, width).join('\t'), expected: parts[width] ?? '' }
})

// the three classes of the 170 cases the generated data cannot reproduce (locale/log.md, 0004)
const CLASSES: Record<string, string> = {
  'en-currency': "ICU writes plain en's currency format (the symbol before the number, en's marks) for en-150 and 25 en-XX locales, where CLDR 48's own file for the locale says otherwise; their number formats agree",
  'cve-mark': "CLDR gives the currency CVE its own decimal mark `$` in kea and pt-CV (currencies.json, per currency) and ICU applies it to every currency there, and the generated module stores no per-currency mark",
  'rsd-digits': "CLDR currencyData fractions say RSD has 0 digits, node's ICU writes 2 (sr, sr-Cyrl, sr-Latn)",
}

function classOf(one: { kind: string; locale: string; key: string }): string {
  if (one.kind === 'c' && /^en-/.test(one.locale)) {
    return 'en-currency'
  }

  if (one.kind === 'c' && (one.locale === 'kea' || one.locale === 'pt-CV')) {
    return 'cve-mark'
  }

  if (one.kind === 'c' && one.key.endsWith('\tRSD')) {
    return 'rsd-digits'
  }

  return 'unclassified'
}

const dir = mkdtempSync(join(tmpdir(), 'term-format-'))
const casesPath = join(dir, 'cases.tsv')
// a copy: the program reads a file, and the scratch folder is where the build runs
writeFileSync(casesPath, readFileSync(join(HERE, 'cases.tsv'), 'utf8'))

const PROGRAM = `load @term/base/text/format
  find format-number
  find format-currency

load @term/base/text
  find split
  find char-count

load @term/base/text/number
  find parse-integer
  find host-parse-float

load @term/base/file
  find read

load @term/base/list
  find list
  find join

task run
  like text
  save out, make list
  save rows
    call split
      call read
        text <${casesPath}>
      text <\\n>
  walk list, read rows
    hook next
      take site, name row
      fork test
        hook test
          call is-above
            call char-count
              read row
            code 0
        hook hold
          save parts
            call split
              read row
              text <\\t>
          fork test
            hook test
              call is-equal
                call get
                  read parts
                  code 0
                text <n>
            hook hold
              save fewest
                call parse-integer
                  call get
                    read parts
                    code 3
              save most
                call parse-integer
                  call get
                    read parts
                    code 4
              push
                read out
                call format-number
                  call host-parse-float
                    call get
                      read parts
                      code 2
                  call get
                    read parts
                    code 1
                  read fewest
                  read most
            hook miss
              push
                read out
                call format-currency
                  call host-parse-float
                    call get
                      read parts
                      code 2
                  call get
                    read parts
                    code 3
                  call get
                    read parts
                    code 1
  send back
    call join
      read out
      text <\\n>
`

const writing = process.argv.includes('--known')

if (writing && existsSync(KNOWN_FILE)) {
  console.log(`refused: ${KNOWN_FILE} exists. known.json only shrinks: a person removes entries by hand.`)
  process.exit(1)
}

const known: Known = writing ? { class: CLASSES, case: {} } : (JSON.parse(readFileSync(KNOWN_FILE, 'utf8')) as Known)
const only = process.env.FORMAT_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'format' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form !== 'ran') {
    ok(`${backend}: the formatter built and ran`, false, `${ran.stage}: ${ran.reason}`)
    continue
  }

  const got = ran.output.split('\n')
  const own = known.case[backend] ?? {}
  const unknown: string[] = []
  const gone: string[] = []
  const failing: Record<string, string> = {}
  let passed = 0

  refs.forEach((one, at) => {
    if (got[at] === one.expected) {
      passed++

      if (own[one.key] !== undefined) {
        gone.push(JSON.stringify(one.key))
      }

      return
    }

    failing[one.key] = classOf(one)

    if (own[one.key] === undefined) {
      unknown.push(`${JSON.stringify(one.key)} got ${JSON.stringify(got[at] ?? '')} node ${JSON.stringify(one.expected)}`)
    }
  })

  if (writing) {
    known.case[backend] = failing
  }

  console.log(`${backend} ${passed} of ${refs.length}, known.json holds ${Object.keys(own).length}`)
  ok(`${backend}: every case equals node's Intl except those in known.json`, writing || unknown.length === 0, `${unknown.length} new: ${unknown.slice(0, 5).join(' | ')}`)
  ok(`${backend}: every known case still differs`, writing || gone.length === 0, `now passing, take off known.json: ${gone.slice(0, 5).join(' | ')}`)
  ok(`${backend}: every known case has a named class`, writing || Object.values(own).every(name => known.class[name] !== undefined), '')
}

if (writing) {
  const unclassified = BACKENDS.filter(b => known.case[b]).flatMap(b => Object.entries(known.case[b]!).filter(([, name]) => name === 'unclassified').map(([key]) => `${b} ${key}`))

  if (unclassified.length > 0) {
    console.log(`not written: ${unclassified.length} failing cases fit no class, e.g. ${unclassified[0]}`)
    process.exit(1)
  }

  writeFileSync(KNOWN_FILE, `${JSON.stringify(known, null, 2)}\n`)
  console.log(`wrote ${KNOWN_FILE}`)
  process.exit(0)
}

console.log(`\ntext-format: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
