// The mockup page as fixtures (note/term/output/mockups.html): every card's caption, command, column width, and its
// lines as plain text with the role of each character, so a golden test can check color as well as text.
//
// Each `<div style="white-space: pre">` inside a card's body is one terminal line and each `<div style="height:
// 22px">` a blank one. A span's color names its role by the palette of section 16, in either theme; `font-weight:
// 600` is bold and a background is the focus highlight (or the terminal's cursor, which is no part of the output).
//
//   npx tsx test/item/mockup.ts            write test/item/mockups.json
//   npx tsx test/item/mockup.ts --check    exit 1 when mockups.json is not what the page extracts to now

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type MockupCharacter = { role: string; strong: boolean; focus: boolean }

export type MockupLine = { text: string; marks: MockupCharacter[] }

export type Mockup = { caption: string; command: string; width: number; lines: MockupLine[] }

const ROLE_BY_COLOR: Record<string, string> = {
  '#E6E6E1': 'text',
  '#1C1E20': 'text',
  '#8A8F95': 'dim',
  '#6B6F75': 'dim',
  '#3A3F44': 'faint',
  '#CFD1D4': 'faint',
  '#8FCB9B': 'done',
  '#2E7D45': 'done',
  '#F08C8C': 'failed',
  '#B93A3A': 'failed',
  '#E8C77A': 'warning',
  '#8A5A00': 'warning',
  '#8FB8E8': 'active',
  '#2F5FA8': 'active',
  '#8FB3D9': 'source',
  '#3D6797': 'source',
}

// the focus highlight of a choice; any other background (#E6E6E1) is the terminal's cursor
const FOCUS_BACKGROUNDS = new Set(['#1D2630'])

function decode(value: string): string {
  return value
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/ /g, ' ')
}

function readLine(html: string, base: string): MockupLine {
  let text = ''
  const marks: MockupCharacter[] = []
  const pattern = /<span style="([^"]*)">([^<]*)<\/span>|([^<]+)/g
  let found: RegExpExecArray | null

  while ((found = pattern.exec(html))) {
    const style = found[1] ?? ''
    const value = decode(found[2] ?? found[3] ?? '')
    const color = /(?:^|;)\s*color:\s*(#[0-9A-Fa-f]{6})/.exec(style)?.[1]?.toUpperCase()
    const background = /background:\s*(#[0-9A-Fa-f]{6})/.exec(style)?.[1]?.toUpperCase()
    const focus = background ? FOCUS_BACKGROUNDS.has(background) : false
    // a background that is not the focus highlight is the terminal's cursor, drawn over whatever is under it
    const cursor = Boolean(background) && !focus
    const named = found[1] !== undefined ? (color ? (ROLE_BY_COLOR[color] ?? `unknown ${color}`) : base) : base
    const role = cursor ? 'cursor' : named
    const mark = { role, strong: /font-weight:\s*600/.test(style), focus }

    for (const character of value) {
      text += character
      marks.push(mark)
    }
  }

  return { text, marks }
}

export function readMockups(html: string): Mockup[] {
  const cards: Mockup[] = []
  const figures = html.split('<figure class="card"').slice(1)

  for (const figure of figures) {
    const caption = decode(/<figcaption>([^<]*)<\/figcaption>/.exec(figure)?.[1] ?? '')
    const header = /<span style="white-space: pre">([^<]*)<\/span><span style="white-space: pre">(\d+) columns<\/span>/.exec(figure)
    const command = decode(header?.[1] ?? '').replace(/^[^·]*·\s*/, '')
    const width = Number(header?.[2] ?? 0)
    const body = figure.split('<div style="padding: 28px 32px; display: flex; flex-direction: column">')[1] ?? ''
    const lines: MockupLine[] = []
    const pattern = /<div style="white-space: pre">(.*?)<\/div>|<div style="height: 22px"><\/div>/g
    let found: RegExpExecArray | null

    while ((found = pattern.exec(body))) {
      lines.push(found[1] === undefined ? { text: '', marks: [] } : readLine(found[1], 'text'))
    }

    cards.push({ caption, command, width, lines })
  }

  return cards
}

// the repository root, from the Term package root every suite runs in
export const MOCKUP_PAGE = join(process.cwd(), '../../../../note/term/output/mockups.html')
export const MOCKUP_FIXTURE = join(process.cwd(), 'test/item/mockups.json')
export const MOCKUP_DIFFERENCES = join(process.cwd(), '../../../../note/term/output/mockup-differences.md')

export function loadMockups(): Mockup[] {
  return JSON.parse(readFileSync(MOCKUP_FIXTURE, 'utf8')) as Mockup[]
}

const isMain = process.argv[1]?.endsWith('mockup.ts')

if (isMain) {
  const extracted = readMockups(readFileSync(MOCKUP_PAGE, 'utf8'))
  const written = `${JSON.stringify(extracted, null, 1)}\n`

  if (process.argv.includes('--check')) {
    const current = readFileSync(MOCKUP_FIXTURE, 'utf8')
    console.log(current === written ? `mockups: ${extracted.length} cards, current` : 'mockups: STALE, run npx tsx test/item/mockup.ts')
    process.exit(current === written ? 0 : 1)
  }

  writeFileSync(MOCKUP_FIXTURE, written)
  console.log(`mockups: ${extracted.length} cards written to test/item/mockups.json`)
}
