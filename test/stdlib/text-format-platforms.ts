// The platform report for numbers and money (decision D7, term/decisions-2026-10/locale): how far today's
// `text/format`, each platform's own formatter (`Intl.NumberFormat` on node, Foundation's `NumberFormatter` on
// Swift, `java.text.NumberFormat` on Kotlin), agrees with the frozen reference, on every case of the corpus.
// Not a gate row. It prints `<backend> <agree> of <cases>` per backend and the ten commonest classes of disagreement.
//
// The reference is node's `Intl.NumberFormat` (roundingMode halfEven) on CLDR 48.0, frozen into
// test/stdlib/text-format/reference.tsv, whose first line names the versions. The cases are written to
// test/stdlib/text-format/cases.tsv, and ONE Term program per backend reads that file: the cases are never inline.
//
// Run: npx tsx test/stdlib/text-format-platforms.ts   (FORMAT_ONLY=typescript, swift or kotlin runs one;
//      FORMAT_LIMIT=n keeps the first n cases, for a quick look)
// Make the reference, once: npx tsx test/stdlib/text-format-platforms.ts --make   (reads the CLDR zip of
//      TEXT_FORMAT_CLDR_ZIP, by default the dataset in land/base/datasets/unicode/cldr-json-48.0.0)
// `--make` refuses to overwrite an existing reference or case file. `--refresh` writes reference.next.tsv and
// cases.next.tsv beside them instead, for a person to compare and move into place.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { runOn } from '../compile/shared/run-on'

const HERE = resolve(process.cwd(), 'test/stdlib/text-format')
const ZIP = process.env.TEXT_FORMAT_CLDR_ZIP ?? resolve(process.cwd(), '../../../../../../land/base/datasets/unicode/cldr-json-48.0.0/cldr-48.0.0-json-full.zip')

// the values, as JavaScript writes them, and the (fewest, most) pairs
const VALUES = ['0', '-0', '0.125', '0.5', '1.5', '2.5', '1.005', '1.015', '-1234.5', '1234.5', '12345.678', '1234567.891', '0.000001234', '123456789012.345', '1e21', 'NaN', 'Infinity', '-Infinity']
const DIGITS: [number, number][] = [[0, 0], [0, 2], [2, 2], [1, 3]]
const CURRENCIES = ['USD', 'EUR', 'JPY', 'INR', 'CHF']
const AMOUNTS = ['1234.5', '-1234.5']

const unzip = (path: string): any => JSON.parse(execFileSync('unzip', ['-p', ZIP, path], { maxBuffer: 1 << 28, encoding: 'utf8' }))

type Row = { kind: 'n' | 'c'; locale: string; value: string; a: string; b: string }

// the currency a region uses now: the entry with no end date and legal tender, the latest start
function regionCurrencies(): Record<string, string> {
  const region = unzip('cldr-core/supplemental/currencyData.json').supplemental.currencyData.region as Record<string, Record<string, { _from?: string; _to?: string; _tender?: string }>[]>
  const out: Record<string, string> = {}

  for (const [code, list] of Object.entries(region)) {
    const live = list.flatMap(entry => Object.entries(entry).map(([currency, info]) => ({ currency, ...info }))).filter(one => !one._to && one._tender !== 'false')
    live.sort((x, y) => String(x._from).localeCompare(String(y._from)))

    if (live.length > 0) {
      out[code] = live[live.length - 1]!.currency
    }
  }

  return out
}

function makeCorpus(): { rows: Row[]; expected: string[]; header: string } {
  const available: string[] = unzip('cldr-core/availableLocales.json').availableLocales.full
  const own = regionCurrencies()
  const rows: Row[] = []
  const expected: string[] = []
  let locales = 0

  for (const locale of available) {
    let resolved = ''

    try {
      resolved = new Intl.NumberFormat(locale).resolvedOptions().locale
    } catch {
      continue
    }

    if (resolved !== locale) {
      continue
    }

    locales++
    const number = (fewest: number, most: number) => new Intl.NumberFormat(locale, { minimumFractionDigits: fewest, maximumFractionDigits: most, roundingMode: 'halfEven' } as Intl.NumberFormatOptions)

    for (const value of VALUES) {
      for (const [fewest, most] of DIGITS) {
        rows.push({ kind: 'n', locale, value, a: String(fewest), b: String(most) })
        expected.push(number(fewest, most).format(Number(value)))
      }
    }

    const region = new Intl.Locale(locale).maximize().region ?? ''
    const currencies = [...new Set([...CURRENCIES, ...(own[region] ? [own[region]!] : [])])]

    for (const currency of currencies) {
      for (const value of AMOUNTS) {
        rows.push({ kind: 'c', locale, value, a: currency, b: '' })
        expected.push(new Intl.NumberFormat(locale, { style: 'currency', currency, roundingMode: 'halfEven' } as Intl.NumberFormatOptions).format(Number(value)))
      }
    }
  }

  const zipHash = createHash('sha256').update(readFileSync(ZIP)).digest('hex')
  const header = `# node ${process.versions.node} icu ${process.versions.icu} cldr ${process.versions.cldr} ${locales} locales ${rows.length} cases cldr-zip-sha256 ${zipHash}`

  return { rows, expected, header }
}

const rowText = (one: Row): string => (one.kind === 'n' ? `n\t${one.locale}\t${one.value}\t${one.a}\t${one.b}` : `c\t${one.locale}\t${one.value}\t${one.a}`)

function make(next: boolean): void {
  const suffix = next ? '.next' : ''
  const referenceFile = join(HERE, `reference${suffix}.tsv`)
  const casesFile = join(HERE, `cases${suffix}.tsv`)

  for (const file of [referenceFile, casesFile]) {
    if (existsSync(file)) {
      console.log(`refused: ${file} exists. A reference is never overwritten: a person removes it, or compares ${next ? 'it' : 'the .next files from --refresh'} first.`)
      process.exit(1)
    }
  }

  const { rows, expected, header } = makeCorpus()

  for (const text of expected) {
    if (/[\t\n]/.test(text)) {
      throw new Error(`a reference text holds a tab or line break: ${JSON.stringify(text)}`)
    }
  }

  mkdirSync(HERE, { recursive: true })
  writeFileSync(referenceFile, `${header}\n${rows.map((one, at) => `${rowText(one)}\t${expected[at]}`).join('\n')}\n`)
  writeFileSync(casesFile, `${rows.map(rowText).join('\n')}\n`)
  console.log(`wrote ${referenceFile} and ${casesFile}: ${rows.length} cases`)
}

if (process.argv.includes('--make') || process.argv.includes('--refresh')) {
  make(process.argv.includes('--refresh'))
  process.exit(0)
}

// the reference, read back: the case columns and the expected text
const lines = readFileSync(join(HERE, 'reference.tsv'), 'utf8').split('\n').filter(line => line !== '' && !line.startsWith('#'))
const limit = Number(process.env.FORMAT_LIMIT ?? lines.length)
const refs = lines.slice(0, limit).map(line => {
  const parts = line.split('\t')

  return { kind: parts[0]!, locale: parts[1]!, key: parts.slice(0, parts[0] === 'n' ? 5 : 4).join('\t'), expected: parts[parts[0] === 'n' ? 5 : 4] ?? '' }
})

// the cases file the program reads is the first `limit` lines of cases.tsv, written to the scratch folder
const dir = mkdtempSync(join(tmpdir(), 'term-format-platforms-'))
const casesPath = join(dir, 'cases.tsv')
writeFileSync(casesPath, `${readFileSync(join(HERE, 'cases.tsv'), 'utf8').split('\n').slice(0, limit).join('\n')}\n`)

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

// the shape of a disagreement: what is left of each text once the common prefix and suffix are cut away, digits as D
const shape = (text: string): string => [...text].map(c => (/\p{Nd}/u.test(c) ? 'D' : `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`)).join(' ')

function classOf(kind: string, got: string, want: string): string {
  if (got === '') {
    return `${kind} nothing written`
  }

  const a = [...got]
  const b = [...want]
  let head = 0

  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++
  }

  let tail = 0

  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) {
    tail++
  }

  const mid = (list: string[]): string => shape(list.slice(head, list.length - tail).join(''))

  return `${kind} got [${mid(a)}] want [${mid(b)}]`
}

const only = process.env.FORMAT_ONLY ?? ''

for (const backend of (['typescript', 'swift', 'kotlin'] as const).filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'platforms' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form !== 'ran') {
    console.log(`${backend} FAILED ${ran.stage}: ${ran.reason}`)
    process.exitCode = 1
    continue
  }

  const got = ran.output.split('\n')
  const classes = new Map<string, { count: number; locale: string; key: string; got: string; want: string }>()
  let agree = 0

  refs.forEach((one, at) => {
    if (got[at] === one.expected) {
      agree++

      return
    }

    const name = classOf(one.kind, got[at] ?? '', one.expected)
    const seen = classes.get(name)

    if (seen) {
      seen.count++
    } else {
      classes.set(name, { count: 1, locale: one.locale, key: one.key, got: got[at] ?? '', want: one.expected })
    }
  })

  console.log(`${backend} ${agree} of ${refs.length}`)

  for (const [name, one] of [...classes.entries()].sort((x, y) => y[1].count - x[1].count).slice(0, 10)) {
    console.log(`  ${String(one.count).padStart(6)}  ${name}   e.g. ${JSON.stringify(one.key)} got ${JSON.stringify(one.got)} want ${JSON.stringify(one.want)}`)
  }

  console.log(`  ${classes.size} classes in all`)
}
