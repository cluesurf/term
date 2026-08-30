// The @term/feed package on the native backends: hex, json, gzip and three flat OTF tables (head/hhea/maxp),
// plus each dialect's @term/seed closure, compiled for Rust, Swift and Kotlin, built with the real toolchain, and
// run against fixed fixtures matching deck/feed/test/*.tree's own expectations. A backend whose toolchain is not
// installed is skipped, never failed. Adapted directly from host-native.ts, whose compiler-API plumbing
// (parse/mill/resolve/check/emit) is package-agnostic. Run: npx tsx test/compile/feed-native.ts
// (HN_ONLY=rust|swift|kotlin runs one backend.)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 600)}`)
  }
}

function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const PACKS: Record<string, string> = { seed: join(TERM, 'deck/seed'), feed: join(TERM, 'deck/feed') }

// the stdlib and the package by name, and relative loads from the file that makes them
const resolver = (path: string, from: string): Source | undefined => {
  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(from.replace(/\/[^/]*$/, ''), path)

    for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(file)) {
        return { file, text: readFileSync(file, 'utf8') }
      }
    }

    return undefined
  }

  const found = /^@(?:cluesurf|term)\/(seed|feed)\/(.*)$/.exec(path)

  if (!found) {
    return undefined
  }

  for (const file of [join(PACKS[found[1]!]!, `${found[2]}.tree`), join(PACKS[found[1]!]!, found[2]!, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

const readRuntime = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)

type Env = 'rust' | 'swift' | 'kotlin'

function frontEnd(env: Env, entry: string, roots: string[]): Program {
  const sources = collectModules({ file: 'main.tree', text: entry }, withNativeEnv(env, resolver)).sources
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(`mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`)
    }

    program.push(...built.program)
  }

  extendForms(program, 'main.tree')
  disambiguateOverloads(program)
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 5).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(roots))
}

// every suite below is (name, entry text, root task, cases). The root task always has signature
// `take input, like text / like text`, even when a suite has nothing that varies (the OTF tables): the driver
// codegen below is written once, generically, against that one shape.
interface Suite {
  id: string
  label: string
  entry: string
  root: string
  cases: [string, string, string][]
}

// hex/code.tree's read-hex/write-hex composed into one round trip, the same shape host-native.ts's round-long
// entry uses. Fixtures: deck/feed/test/hex.tree's own.
const HEX: Suite = {
  id: 'hex',
  label: 'hex',
  root: 'round-hex',
  entry: `load @term/feed/code/hex/code
  find read-hex
  find write-hex

task round-hex
  take input, like text
  like text
  send back
    call write-hex(call read-hex(read input))
`,
  cases: [
    ['lowercase round trips', '00ff7a', '00ff7a'],
    ['uppercase input still lower-cases', '00FF7A', '00ff7a'],
    ['the empty string round trips to itself', '', ''],
    ['a longer real-looking value', 'deadbeefcafef00d', 'deadbeefcafef00d'],
  ],
}

// json/code.tree's read-json/write-json, a real stress test beyond hex: recursive descent through a tagged
// union (json-value's 6 cases) rather than a flat loop, the one dialect with a form that refers to itself
// through a list, and the one with a real `like decimal` accumulator (feedback_term_decimal_vs_number_no_implicit_conversion).
// Fixtures: deck/feed/test/json.tree's own, compact (write-json always produces no spaces).
const JSON_SUITE: Suite = {
  id: 'json',
  label: 'json',
  root: 'round-json',
  entry: `load @term/feed/code/json/code
  find read-json
  find write-json

task round-json
  take input, like text
  like text
  send back
    call write-json(call read-json(read input))
`,
  cases: [
    ['a bare number', '42', '42'],
    ['a negative decimal', '-3.5', '-3.5'],
    ['an escaped quote in a string', '"a \\"quoted\\" word"', '"a \\"quoted\\" word"'],
    ['a nested object and array', '{"a": [1, {"b": true}, null]}', '{"a":[1,{"b":true},null]}'],
  ],
}

// gzip/code.tree's read-gzip/write-gzip, bridged through the already-proven read-hex/write-hex so the driver
// codegen doesn't need a second byte-array-literal shape per backend. The fixture is deck/feed/test/gzip.tree's
// own minimal-gzip-bytes (flags 0x00: no extra/name/comment/header-crc16), so a correct round trip reproduces
// the input byte for byte -- proves feed-cursor's mutation workaround (base.tree, 02-cursor.md) under gzip's own
// read/write, not just json's.
const GZIP: Suite = {
  id: 'gzip',
  label: 'gzip',
  root: 'round-gzip',
  entry: `load @term/feed/code/hex/code
  find read-hex
  find write-hex

load @term/feed/code/gzip/code
  find read-gzip
  find write-gzip

task round-gzip
  take input, like text
  like text
  send back
    call write-hex(call write-gzip(call read-gzip(call read-hex(read input))))
`,
  cases: [['a minimal header+trailer round trips byte for byte', '1f8b08000000000000ffaabb7856341202000000', '1f8b08000000000000ffaabb7856341202000000']],
}

// deck/feed/test/otf-head.tree's own sample-head-table, byte-count plus three fields already proven on
// TypeScript (units-per-em, the signed x-min, the 8-byte created timestamp) -- `input` is unused, the fixture
// is fixed, kept as a parameter only so the driver codegen below stays one shape for every suite.
const OTF_HEAD: Suite = {
  id: 'otf-head',
  label: 'otf head',
  root: 'round-otf-head',
  entry: `load @term/seed/code/list
  find size

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/head/form
  find otf-head-table

load @term/feed/code/font/otf/table/head/code
  find read-otf-head-table
  find write-otf-head-table

task round-otf-head
  take input, like text
  like text
  save table
    make otf-head-table
      bind version-major, code 1
      bind version-minor, code 0
      bind font-revision, code 65536
      bind checksum-adjustment, code 0
      bind magic-number, code 0x5f0f3cf5
      bind flags, code 0
      bind units-per-em, code 1000
      bind created, code 3610281600
      bind modified, code 3610281600
      bind x-min, code -100
      bind y-min, code -50
      bind x-max, code 1000
      bind y-max, code 900
      bind mac-style, code 0
      bind lowest-rec-ppem, code 8
      bind font-direction-hint, code 2
      bind index-to-loc-format, code 0
      bind glyph-data-format, code 0
  save bytes
    call write-otf-head-table(read table)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-head-table(call make-cursor(read bytes))
  send back
    text <{{byte-count}}|{{reread/units-per-em}}|{{reread/x-min}}|{{reread/created}}>
`,
  cases: [['write then read agrees with the fixed sample', '', '54|1000|-100|3610281600']],
}

// deck/feed/test/otf-hhea-maxp.tree's own sample-hhea-table.
const OTF_HHEA: Suite = {
  id: 'otf-hhea',
  label: 'otf hhea',
  root: 'round-otf-hhea',
  entry: `load @term/seed/code/list
  find size

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/hhea/form
  find otf-hhea-table

load @term/feed/code/font/otf/table/hhea/code
  find read-otf-hhea-table
  find write-otf-hhea-table

task round-otf-hhea
  take input, like text
  like text
  save table
    make otf-hhea-table
      bind version-major, code 1
      bind version-minor, code 0
      bind ascender, code 1900
      bind descender, code -500
      bind line-gap, code 0
      bind advance-width-max, code 1200
      bind min-left-side-bearing, code -50
      bind min-right-side-bearing, code -20
      bind x-max-extent, code 1150
      bind caret-slope-rise, code 1
      bind caret-slope-run, code 0
      bind caret-offset, code 0
      bind metric-data-format, code 0
      bind number-of-h-metrics, code 230
  save bytes
    call write-otf-hhea-table(read table)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-hhea-table(call make-cursor(read bytes))
  send back
    text <{{byte-count}}|{{reread/descender}}|{{reread/number-of-h-metrics}}>
`,
  cases: [['write then read agrees with the fixed sample', '', '36|-500|230']],
}

// deck/feed/test/otf-hhea-maxp.tree's own sample-maxp-table.
const OTF_MAXP: Suite = {
  id: 'otf-maxp',
  label: 'otf maxp',
  root: 'round-otf-maxp',
  entry: `load @term/seed/code/list
  find size

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/maxp/form
  find otf-maxp-table

load @term/feed/code/font/otf/table/maxp/code
  find read-otf-maxp-table
  find write-otf-maxp-table

task round-otf-maxp
  take input, like text
  like text
  save table
    make otf-maxp-table
      bind version, code 0x00010000
      bind num-glyphs, code 500
      bind max-points, code 200
      bind max-contours, code 10
      bind max-composite-points, code 0
      bind max-composite-contours, code 0
      bind max-zones, code 2
      bind max-twilight-points, code 16
      bind max-storage, code 32
      bind max-function-defs, code 64
      bind max-instruction-defs, code 0
      bind max-stack-elements, code 512
      bind max-size-of-instructions, code 1024
      bind max-component-elements, code 0
      bind max-component-depth, code 0
  save bytes
    call write-otf-maxp-table(read table)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-maxp-table(call make-cursor(read bytes))
  send back
    text <{{byte-count}}|{{reread/num-glyphs}}>
`,
  cases: [['write then read agrees with the fixed sample', '', '32|500']],
}

// deck/feed/test/otf-os2.tree's own version-0-table (no version-1/version-2 tail: every `maybe` field `none`).
const OTF_OS2: Suite = {
  id: 'otf-os2',
  label: 'otf os2',
  root: 'round-otf-os2',
  entry: `load @term/seed/code/list
  find push
  find size

load @term/seed/code/maybe
  find none

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/os2/form
  find otf-os2-table

load @term/feed/code/font/otf/table/os2/code
  find read-otf-os2-table
  find write-otf-os2-table

task ten-zeros
  like list
    like u8
  save result
    make list
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  send back, read result

task four-zeros
  like list
    like u8
  save result
    make list
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  call push(read(result), code(0))
  send back, read result

task round-otf-os2
  take input, like text
  like text
  save table
    make otf-os2-table
      bind version, code 0
      bind x-avg-char-width, code 500
      bind us-weight-class, code 400
      bind us-width-class, code 5
      bind fs-type, code 0
      bind y-subscript-x-size, code 650
      bind y-subscript-y-size, code 600
      bind y-subscript-x-offset, code 0
      bind y-subscript-y-offset, code 75
      bind y-superscript-x-size, code 650
      bind y-superscript-y-size, code 600
      bind y-superscript-x-offset, code 0
      bind y-superscript-y-offset, code 350
      bind y-strikeout-size, code 50
      bind y-strikeout-position, code 250
      bind s-family-class, code 0
      bind panose, call ten-zeros
      bind ul-unicode-range-1, code 1
      bind ul-unicode-range-2, code 0
      bind ul-unicode-range-3, code 0
      bind ul-unicode-range-4, code 0
      bind ach-vend-id, call four-zeros
      bind fs-selection, code 64
      bind us-first-char-index, code 32
      bind us-last-char-index, code 126
      bind s-typo-ascender, code 800
      bind s-typo-descender, code -200
      bind s-typo-line-gap, code 90
      bind us-win-ascent, code 900
      bind us-win-descent, code 200
      bind ul-code-page-range-1
        make none
      bind ul-code-page-range-2
        make none
      bind sx-height
        make none
      bind s-cap-height
        make none
      bind us-default-char
        make none
      bind us-break-char
        make none
      bind us-max-context
        make none
  save bytes
    call write-otf-os2-table(read table)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-os2-table(call make-cursor(read bytes))
  send back
    text <{{byte-count}}|{{reread/us-weight-class}}|{{reread/s-typo-descender}}>
`,
  cases: [['a version-0 table round trips its always-present fields', '', '78|400|-200']],
}

// deck/feed/test/otf-loca.tree's own sample-offsets fixture, short format (4 entries, so 8 bytes: entries are
// stored as offset/2 and doubled back on read).
const OTF_LOCA: Suite = {
  id: 'otf-loca',
  label: 'otf loca',
  root: 'round-otf-loca',
  entry: `load @term/seed/code/list
  find push
  find get
  find size

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/loca/form
  find otf-loca-table

load @term/feed/code/font/otf/table/loca/code
  find read-otf-loca-table
  find write-otf-loca-table

task round-otf-loca
  take input, like text
  like text
  save offsets
    make list
  call push(read(offsets), code(0))
  call push(read(offsets), code(20))
  call push(read(offsets), code(20))
  call push(read(offsets), code(96))
  save table
    make otf-loca-table
      bind offsets, read offsets
  save bytes
    call write-otf-loca-table(read(table), true)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-loca-table(call make-cursor(read bytes), code 3, true)
  save last-offset
    call get(read(reread/offsets), code(3))
  send back
    text <{{byte-count}}|{{last-offset}}>
`,
  cases: [['a short-format table round trips, including the middle empty-glyph span', '', '8|96']],
}

// deck/feed/test/otf-glyf.tree's own triangle fixture: one contour, three on-curve points, no instructions. The
// writer always emits the long (2-byte) coordinate form (see code.tree's own comment), so the byte count is
// exact and known ahead of time: 10 header + 2 end-points + 2 instruction-length + 3 flags + 6 x-deltas + 6
// y-deltas = 29.
const OTF_GLYF: Suite = {
  id: 'otf-glyf',
  label: 'otf glyf',
  root: 'round-otf-glyf',
  entry: `load @term/seed/code/list
  find push
  find get
  find size

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/glyf/form
  find otf-glyph
  find otf-glyph-point

load @term/feed/code/font/otf/table/glyf/code
  find read-otf-glyph
  find write-otf-glyph

task triangle-third-point-x
  take glyph, like otf-glyph
  like number
  fork case, read glyph
    case otf-glyph-simple
      link contours
      save contour
        call get(read(contours), code(0))
      save point
        call get(read(contour), code(2))
      send back
        read point/x
    case otf-glyph-empty
      halt <expected a simple glyph, found empty>
    case otf-glyph-composite-unsupported
      halt <expected a simple glyph, found an unsupported composite>

task round-otf-glyf
  take input, like text
  like text
  save contour
    make list
  call push
    read contour
    make otf-glyph-point
      bind x, code 0
      bind y, code 0
      bind on-curve, true
  call push
    read contour
    make otf-glyph-point
      bind x, code 500
      bind y, code 0
      bind on-curve, true
  call push
    read contour
    make otf-glyph-point
      bind x, code 250
      bind y, code 700
      bind on-curve, true
  save contours
    make list
  call push(read(contours), read(contour))
  save glyph
    make otf-glyph-simple
      bind x-min, code 0
      bind y-min, code 0
      bind x-max, code 500
      bind y-max, code 700
      bind contours, read contours
      bind instructions, make list
  save bytes
    call write-otf-glyph(read glyph)
  save byte-count
    call size(read bytes)
  save reread
    call read-otf-glyph(call make-cursor(read bytes), read byte-count)
  save third-x
    call triangle-third-point-x(read reread)
  send back
    text <{{byte-count}}|{{third-x}}>
`,
  cases: [['a simple triangle round trips its byte count and third point', '', '29|250']],
}

// deck/feed/test/otf-cmap.tree's own cmap-bytes fixture (one encoding record pointing at a format-12 subtable
// with one group), bridged through the already-proven read-hex so the driver doesn't need a byte-array-literal
// shape for a third dialect. The hardest shape in the package: `mine at` (offset relative to the cmap table's
// own start, proven by the group surviving a read at all) composed with a format-discriminated union. Proves
// both directions: a straight read, and a write-then-reread that must recompute the subtable-offset correctly.
const OTF_CMAP: Suite = {
  id: 'otf-cmap',
  label: 'otf cmap',
  root: 'round-otf-cmap',
  entry: `load @term/seed/code/list
  find get
  find size

load @term/feed/code/hex/code
  find read-hex

load @term/feed/code/base
  find make-cursor

load @term/feed/code/font/otf/table/cmap/form
  find otf-cmap-table
  find otf-cmap-encoding-record
  find otf-cmap-subtable
  find otf-cmap-group

load @term/feed/code/font/otf/table/cmap/code
  find read-otf-cmap-table
  find write-otf-cmap-table

task cmap-group-1
  take subtable, like otf-cmap-subtable
  like otf-cmap-group
  fork case, read subtable
    case otf-cmap-format-12
      link groups
      send back
        call get(read(groups), code(0))
    case otf-cmap-format-4
      halt <expected a format 12 subtable, found format 4>
    case otf-cmap-format-unsupported
      halt <expected a format 12 subtable, found an unsupported format>

task round-otf-cmap
  take input, like text
  like text
  save bytes
    call read-hex(read input)
  save byte-count
    call size(read bytes)
  save table
    call read-otf-cmap-table(call make-cursor(read bytes))
  save record
    call get(read(table/records), code(0))
  save group
    call cmap-group-1(read record/subtable)
  save rewritten
    call write-otf-cmap-table(read table)
  save reread
    call read-otf-cmap-table(call make-cursor(read rewritten))
  save record-2
    call get(read(reread/records), code(0))
  save group-2
    call cmap-group-1(read record-2/subtable)
  send back
    text <{{byte-count}}|{{record/platform-id}}|{{group/start-char-code}}|{{group/end-char-code}}|{{record-2/subtable-offset}}|{{group-2/start-glyph-id}}>
`,
  cases: [
    ['a format-12 group reads, then survives a write and reread', '000000010003000a0000000c000c00000000001c0000000000000001000000410000005a00000024', '40|3|65|90|12|36'],
  ],
}

// deck/feed/test/pdf-object.tree's own fixtures: a dictionary (the number-vs-reference lookahead does not fire),
// an array of two indirect references (it does, twice), and a negative decimal (the same `like decimal`
// accumulator shape json's own number parser needed — see feedback_term_decimal_vs_number_no_implicit_
// conversion).
const PDF_OBJECT: Suite = {
  id: 'pdf-object',
  label: 'pdf object',
  root: 'round-pdf-value',
  entry: `load @term/feed/code/pdf/1.7/object/code
  find make-text-cursor
  find parse-pdf-value
  find write-pdf-value

task round-pdf-value
  take input, like text
  like text
  send back
    call write-pdf-value
      call parse-pdf-value(call make-text-cursor(read input))
`,
  cases: [
    ['a dictionary round trips compact', '<< /Type /Catalog /Count 3 >>', '<</Type /Catalog /Count 3>>'],
    ['two references inside an array round trip', '[12 0 R 13 0 R]', '[12 0 R 13 0 R]'],
    ['a negative decimal round trips', '-3.5', '-3.5'],
  ],
}

const SUITES: Suite[] = [HEX, JSON_SUITE, GZIP, OTF_HEAD, OTF_HHEA, OTF_MAXP, OTF_OS2, OTF_CMAP, OTF_LOCA, OTF_GLYF, PDF_OBJECT]

const SEP = ''
const dir = mkdtempSync(join(tmpdir(), 'term-feed-native-'))

function compare(env: string, label: string, cases: Suite['cases'], output: string): void {
  const got = output.split(SEP)
  cases.forEach(([name, , want], at) =>
    ok(`${env} ${label}: ${name}`, got[at] === want, `got ${JSON.stringify(got[at] ?? '')} want ${JSON.stringify(want)}`),
  )
}

const CARGO_ENV = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'term-feed-native-target') }

function runSuiteRust(suite: Suite): void {
  const program = frontEnd('rust', suite.entry, [suite.root])
  const out = join(dir, `rust-${suite.id}`)
  mkdirSync(join(out, 'src'), { recursive: true })
  writeFileSync(join(out, 'Cargo.toml'), `[package]\nname = "feed_${suite.id.replace(/-/g, '_')}"\nversion = "0.1.0"\nedition = "2021"\n`)
  const fn = suite.root.replace(/-/g, '_')
  const inputs = suite.cases.map(([, input]) => JSON.stringify(input))
  const emitted = emitRust(program)
  // not every root task's Rust signature returns Result<String, TermException> -- only one does when something
  // in its closure can actually halt (hex/json/gzip/otf-head/otf-maxp all have a raising path somewhere;
  // otf-hhea/otf-os2 don't, since neither reader validates anything that halts), so the call site has to match
  // whichever the emitter actually produced rather than assume every suite is fallible.
  const fallible = new RegExp(`fn ${fn}\\([^)]*\\)\\s*->\\s*(?:std::result::)?Result<`).test(emitted)
  const callExpr = (arg: string): string =>
    fallible ? `${fn}(${arg}).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })` : `${fn}(${arg})`
  const main = `\nfn main() {\n  let inputs: Vec<&str> = vec![${inputs.join(', ')}];\n  for input in inputs { print!("{}\\u{1e}", ${callExpr('input.to_string()')}); }\n}\n`
  writeFileSync(join(out, 'src/main.rs'), `${nativePrelude(program, 'rust', readRuntime)}\n${emitted}${main}`)

  try {
    const output = execFileSync('cargo', ['run', '--quiet'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'], env: CARGO_ENV }).toString()
    ok(`rust: the ${suite.label} package builds`, true)
    compare('rust', suite.label, suite.cases, output)
  } catch (error) {
    ok(`rust: the ${suite.label} package builds`, false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

function runSuiteSwift(suite: Suite): void {
  const program = frontEnd('swift', suite.entry, [suite.root])
  const out = join(dir, 'swift')
  mkdirSync(out, { recursive: true })
  const file = join(out, `${suite.id}.swift`)
  const fn = suite.root.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  const inputs = suite.cases.map(([, input]) => JSON.stringify(input))
  const emitted = emitSwift(program)
  // `try!` on a call to a function Swift did NOT mark `throws` is a compile error ("no calls to throwing
  // functions occur"), so this has to match the emitter's own signature, same reasoning as Rust's Result check.
  const fallible = new RegExp(`func ${fn}\\([^)]*\\)\\s*throws\\s*->`).test(emitted)
  const call = (arg: string): string => (fallible ? `try! ${fn}(${arg})` : `${fn}(${arg})`)
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitted}\nfor input in [${inputs.join(', ')}] { print(${call('input')}, terminator: "\\u{1e}") }\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(out, suite.id), file], { stdio: 'pipe' })
  } catch (error) {
    ok(`swift: the ${suite.label} package builds`, false, String((error as { stderr?: Buffer }).stderr ?? error))

    return
  }

  ok(`swift: the ${suite.label} package builds`, true)
  compare('swift', suite.label, suite.cases, execFileSync(join(out, suite.id)).toString())
}

function runSuiteKotlin(suite: Suite): void {
  const program = frontEnd('kotlin', suite.entry, [suite.root])
  const out = join(dir, 'kotlin')
  mkdirSync(out, { recursive: true })
  const file = join(out, `${suite.id}.kt`)
  const fn = suite.root.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
  const inputs = suite.cases.map(([, input]) => JSON.stringify(input))
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { for (input in listOf(${inputs.join(', ')})) { print(${fn}(input) + "\\u001e") } }\n`,
    ),
  )

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', join(out, `${suite.id}.jar`)], { stdio: 'pipe' })
  } catch (error) {
    ok(`kotlin: the ${suite.label} package builds`, false, String((error as { stderr?: Buffer }).stderr ?? error))

    return
  }

  ok(`kotlin: the ${suite.label} package builds`, true)
  compare('kotlin', suite.label, suite.cases, execFileSync('java', ['-jar', join(out, `${suite.id}.jar`)]).toString())
}

const only = process.env.HN_ONLY ?? ''

if (!only || only === 'rust') {
  if (have('cargo')) {
    SUITES.forEach(runSuiteRust)
  } else {
    skipped('rust: the package builds and round-trips', 'cargo not installed')
  }
}

if (!only || only === 'swift') {
  if (have('swiftc')) {
    SUITES.forEach(runSuiteSwift)
  } else {
    skipped('swift: the package builds and round-trips', 'swiftc not installed')
  }
}

if (!only || only === 'kotlin') {
  if (have('kotlinc') && have('java')) {
    SUITES.forEach(runSuiteKotlin)
  } else {
    skipped('kotlin: the package builds and round-trips', 'kotlinc/java not installed')
  }
}

console.log(`\nfeed-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
