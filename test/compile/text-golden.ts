// The text golden (native-text-0004): a page of every script the web font registry sets, on AppKit (macOS), UIKit
// (the iPhone simulator) and Android views (the emulator), and how many of each script's characters the platform
// draws as a box. The unbiased witness on "no boxes": the characters are not chosen by hand, they are read from
// Unicode itself (`\p{Script=...}`, every character of a small script and 64 spread evenly over a large one), and the
// answer is read from what the platform drew (CoreText's runs on Apple, the TextView's paint on Android).
//
// Each row is set in the family the font contract picks for its script (deck/face/code/font/font.tree,
// `resolve-font`), so the page asks for what a Term app asks for. Until a font is bundled for a script (its licence
// first, note/term/project/native-text-fonts.md) the platform's own fonts are what draw it, and on a phone that leaves
// boxes in the ancient and minority scripts. So the gate is a BASELINE that may only shrink, like `hold.json`:
// text-golden.baseline.json holds the boxes per platform per script, a count over it fails, and
// TEXT_GOLDEN_COMMIT=1 rewrites it for the platforms that ran. The counts are printed either way, never hidden.
//
// Five slugs name no Unicode script (code, emoji, tone and the two Siyaq number sets) and are listed as unmeasured.
// GOLDEN_ONLY=macos (or ios, android) runs one platform. Run: npx tsx test/compile/text-golden.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import SCRIPT from '../../../../../../mesh/deck/belt/code/base/script'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

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

// the slugs whose Unicode name is not the slug written in title case, and the scripts each covers
const UNICODE_NAME: Record<string, string[]> = {
  anatolian: ['Anatolian_Hieroglyphs'],
  lontara: ['Buginese'],
  canadian: ['Canadian_Aboriginal'],
  egyptian: ['Egyptian_Hieroglyphs'],
  geez: ['Ethiopic'],
  hk: ['Han'],
  parthian: ['Inscriptional_Parthian'],
  japanese: ['Hiragana', 'Katakana'],
  korean: ['Hangul'],
  meroitic: ['Meroitic_Hieroglyphs', 'Meroitic_Cursive'],
  burmese: ['Myanmar'],
  'n-ko': ['Nko'],
  khitan: ['Khitan_Small_Script'],
  chinese: ['Han'],
  'arabic-nastaliq': ['Arabic'],
  'sign-writing': ['SignWriting'],
  'syriac-eastern': ['Syriac'],
}

// the slugs that name no Unicode script: measured by nothing here, and said so
const UNMEASURED = new Set(['code', 'emoji', 'tone', 'indic-siyaq-numbers', 'ottoman-siyaq'])
const PROBE = 64
// what a Term text literal cannot carry, and what is not a glyph
const UNCARRIABLE = /[<>{}\\\s\p{Cc}\p{Cf}]/u

const unicodeNames = (slug: string): string[] =>
  UNICODE_NAME[slug] ?? [slug.split('-').map(part => part[0]!.toUpperCase() + part.slice(1)).join('_')]

// every assigned code point, once, as one string the per-script expressions scan
const EVERY = (() => {
  const parts: string[] = []

  for (let code = 0x21; code <= 0x323af; code++) {
    if (code >= 0xd800 && code <= 0xdfff) {
      continue
    }
    parts.push(String.fromCodePoint(code))
  }

  return parts.join('')
})()

type Row = { slug: string; probe: string; size: number }

const rows: Row[] = []
const unmeasured: string[] = []

for (const slug of Object.keys(SCRIPT).sort()) {
  if (UNMEASURED.has(slug)) {
    unmeasured.push(slug)
    continue
  }

  const characters = unicodeNames(slug).flatMap(name => EVERY.match(new RegExp(`\\p{Script=${name}}`, 'gu')) ?? [])
    .filter(character => !UNCARRIABLE.test(character))
  const step = Math.max(1, characters.length / PROBE)
  const probe = Array.from({ length: Math.min(PROBE, characters.length) }, (_, i) => characters[Math.floor(i * step)]!)
  rows.push({ slug, probe: probe.join(''), size: characters.length })
}

const rowCalls = rows
  .map(row => `  call add-row
    read root
    text <${row.slug}>
    text <${row.probe}>`)
  .join('\n')

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find create-element
  find create-text
  find append
  find set-style
  find child-at
  find child-count
  find missing-glyphs
  find snapshot
  find say

load @term/face/code/font/font
  find resolve-font

load @term/base/list
  find list

# one row: the script's probe text, set in the family the font contract picks for it
task add-row
  take root, like view
  take script, like text
  take probe, like text
  save face
    call resolve-font
      bind script, read script
  save row
    call create-element
      text <span>
  call set-style
    read row
    text <font-family>
    read face/family
  call append
    read row
    call create-text
      read probe
  call append
    read root
    read row

# what the platform drew as a box, row by row
task report
  take root, like view
  save rows
    call child-count
      read root
  walk size
    bind base, code 0
    bind head, read rows
    hook next
      take site, name index
      save missing
        call missing-glyphs
          call child-at
            call child-at
              read root
              read index
            code 0
      call say
        text <gap {{index}}|{{missing}}|>

task main
  save root
    call open-root
      text <Term text golden>
      code 900
      code 1200
${rowCalls}
  call after-launch
    task check
      call show-window
      call report
        read root
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

const BASELINE = join(process.cwd(), 'test/compile/text-golden.baseline.json')
type Baseline = Partial<Record<Leg, Record<string, number>>>
const baseline: Baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
const measured: Baseline = {}

// the boxes each row reported, by script, as code points: what a person sees as a box
function gapsOf(output: string): Map<string, string[]> {
  const gaps = new Map<string, string[]>()

  for (const line of output.split('\n')) {
    const found = /gap (\d+)\|([^|]*)\|/.exec(line)

    if (found && rows[Number(found[1])]) {
      gaps.set(rows[Number(found[1])]!.slug, [...found[2]!])
    }
  }

  return gaps
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const gaps = gapsOf(output)
  ok(`${leg}: every one of the ${rows.length} rows reported (${toolkit})`, gaps.size === rows.length, `${gaps.size} reported`)

  const counts: Record<string, number> = {}
  const boxed: string[] = []
  const worse: string[] = []

  for (const row of rows) {
    const missing = gaps.get(row.slug) ?? []
    counts[row.slug] = missing.length

    if (missing.length > 0) {
      boxed.push(`${row.slug} ${missing.length}/${[...row.probe].length}`)
    }

    if (missing.length > (baseline[leg]?.[row.slug] ?? 0)) {
      worse.push(`${row.slug} ${baseline[leg]?.[row.slug] ?? 0} -> ${missing.length}`)
    }
  }

  measured[leg] = counts
  const whole = rows.length - boxed.length
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  console.log(`      ${leg}: ${whole} of ${rows.length} scripts draw every probe character; ${total} boxes over ${boxed.length} scripts`)

  if (boxed.length > 0) {
    console.log(`      ${leg} boxes: ${boxed.join(', ')}`)
  }

  // GOLDEN_DETAIL=1: the code points behind each count, so a box can be looked up rather than believed
  if (process.env.GOLDEN_DETAIL === '1') {
    for (const row of rows) {
      const missing = gaps.get(row.slug) ?? []

      if (missing.length > 0) {
        console.log(`      ${leg} ${row.slug}: ${missing.map(c => `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`).join(' ')}`)
      }
    }
  }

  ok(`${leg}: no script draws more boxes than its baseline`, worse.length === 0, worse.join(', '))
}

console.log(`text-golden: ${rows.length} scripts measured, ${rows.reduce((sum, row) => sum + [...row.probe].length, 0)} probe characters; unmeasured (no Unicode script): ${unmeasured.join(', ')}`)

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-text-golden-')),
    name: 'Golden',
    iosIdentifier: 'surf.term.text-golden-test',
    androidIdentifier: 'surf.term.textgolden',
    program,
    judge,
    ok,
    shots: { macos: process.env.SNAPSHOT_GOLDEN, ios: process.env.SNAPSHOT_GOLDEN_IOS, android: process.env.SNAPSHOT_GOLDEN_ANDROID },
  },
  process.env.GOLDEN_ONLY ?? '',
)

if (process.env.TEXT_GOLDEN_COMMIT === '1') {
  writeFileSync(BASELINE, `${JSON.stringify({ ...baseline, ...measured }, null, 2)}\n`)
  console.log(`      baseline written for ${Object.keys(measured).join(', ')}`)
}

console.log(`\ntext-golden: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
