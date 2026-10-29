// LAW 7'S TEXT STEP: escape.tree's `escape-html` runs glyph.tree's `escape-glyphs`, which law.tree proves keeps no
// `<`, `>`, `&`, `"` or `'` (safe-text-escape) and reads back to its input (safe-text-round-trip). What the kernel
// cannot see is the text around it: `glyphs-of` reading each character's glyph, and `write-pieces` writing each kept
// character back in its place. This holds that step, as the node host runs it, against the five replacements the
// escape always meant, on every ASCII character alone, on texts that are not ASCII, and on 5,000 random texts.
//
// Run: npx tsx test/assurance/escape.ts (from deck/term/deck/term). It builds test/assurance/notes first.

import { spawnSync } from 'node:child_process'

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

const NOTES = new URL('./notes/', import.meta.url).pathname
const LINE = new URL('../../host/line.js', import.meta.url).pathname
const made = spawnSync('node', [LINE, 'make'], {
  cwd: NOTES,
  encoding: 'utf8',
})
ok(
  'test/assurance/notes builds',
  made.status === 0,
  `${made.stdout}${made.stderr}`.slice(-2000),
)

const unit = (await import(
  new URL(
    './notes/host/.unit/_term_site_code_http_escape.ts',
    import.meta.url,
  ).href
)) as {
  escapeHtml: (value: string) => string
}

const meant = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

const ascii = Array.from({ length: 128 }, (_, code) =>
  String.fromCharCode(code),
)
const wrong = ascii.filter(
  char => unit.escapeHtml(char) !== meant(char),
)
ok(
  'every ASCII character alone escapes as meant',
  wrong.length === 0,
  JSON.stringify(wrong),
)

const named = [
  '',
  '<script>alert("x")</script>',
  "it's",
  '&amp;',
  'a&b<c>d"e\'f',
  'नमस्ते <b>',
  '𝄞 & 𝄞',
  '<<>>&&""\'\'',
]
for (const text of named) {
  ok(
    `${JSON.stringify(text)} escapes as meant`,
    unit.escapeHtml(text) === meant(text),
    unit.escapeHtml(text),
  )
}

// a fixed generator, so a failure is reproducible
let seed = 7
const next = (): number => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed
}
const alphabet = [
  '<',
  '>',
  '&',
  '"',
  "'",
  'a',
  ' ',
  ';',
  '#',
  'l',
  't',
  'é',
  '𝄞',
  '\n',
  '=',
]
let random = 0
let differ = ''
for (let n = 0; n < 5000; n++) {
  const length = next() % 24
  const text = Array.from(
    { length },
    () => alphabet[next() % alphabet.length],
  ).join('')
  if (unit.escapeHtml(text) === meant(text)) {
    random++
  } else if (!differ) {
    differ = JSON.stringify(text)
  }
}
ok('5,000 random texts escape as meant', random === 5000, differ)

// what law 7 says of the text, read off the output: no `<`, `>`, `"` or `'`, and every `&` begins one of the five
const entity = /&(lt|gt|amp|quot|#39);/g
const clean = named.every(text => {
  const out = unit.escapeHtml(text).replace(entity, '')
  return !/[<>&"']/.test(out)
})
ok(
  'no output holds <, >, " or \', and every & begins an entity it wrote',
  clean,
)

console.log(`\nescape: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
