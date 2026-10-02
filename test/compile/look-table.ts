// The look style table (native-dom-0008): a `look` sheet compiled for a host with no CSS engine. Every `face` class
// becomes typed rows with its tokens resolved at build time, its state variants become rows keyed on an attribute, and
// whatever cannot lower is NAMED with its reason, never dropped. The face theme is the real input: its table must hold
// every class it declares, and the only things it names must be the four it really cannot lower.
// Run: npx tsx test/compile/look-table.ts

import { compileLookTable, declarationOf, styleTableText } from '@term/make/code/compile/look-table'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

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
const THEME = path.join(TERM, 'deck/face/code/style/theme.tree')
const theme = { file: THEME, text: readFileSync(THEME, 'utf8') }

const light = compileLookTable(theme)
const dark = compileLookTable(theme, { scheme: 'dark' })

// every `face` the sheet declares is a class of the table, in order
const declared = [...theme.text.matchAll(/^face ([a-z-]+)$/gm)].map(match => match[1])
ok('every class face declares is in the table', JSON.stringify(light.classes.map(c => c.name)) === JSON.stringify(declared), JSON.stringify(light.classes.map(c => c.name)))

const rows = (table: typeof light, name: string) =>
  table.classes.find(c => c.name === name)?.rows.map(declarationOf).join('; ') ?? ''

// tokens resolve through two levels (`surface` is `var(--color-zinc-50)`), rem becomes points, padding expands
ok(
  'the panel resolves its tokens, light',
  rows(light, 'panel') === 'background: #fafafa; color: #18181b; border: 1px solid #e4e4e7; border-radius: 8px; padding: 16px 16px 16px 16px',
  rows(light, 'panel'),
)
ok(
  'the dark scheme lays `tone dark` over the base tokens',
  rows(dark, 'panel') === 'background: #09090b; color: #f4f4f5; border: 1px solid #27272a; border-radius: 8px; padding: 16px 16px 16px 16px',
  rows(dark, 'panel'),
)
ok('a token the dark tone leaves alone keeps its base value', rows(dark, 'kbd').startsWith('background: #f4f4f5'), rows(dark, 'kbd'))

// state variants are rows keyed on the attribute the component sets
const overlay = light.classes.find(c => c.name === 'overlay')
ok(
  'data-state variants become attribute rows',
  JSON.stringify(overlay?.states.map(s => [s.attribute, s.value, s.rows.map(declarationOf)])) ===
    JSON.stringify([['data-state', 'open', ['opacity: 1']], ['data-state', 'closed', ['opacity: 0']]]),
  JSON.stringify(overlay?.states),
)
const control = light.classes.find(c => c.name === 'control')
ok(
  '`disabled` becomes a row on the disabled attribute',
  JSON.stringify(control?.states.map(s => [s.attribute, s.value, s.rows.map(declarationOf)])) === JSON.stringify([['disabled', undefined, ['opacity: 0.5']]]),
  JSON.stringify(control?.states),
)

// the four things face's theme cannot lower, named with a reason, and nothing else
const named = light.unlowered.map(miss => `${miss.at} ${miss.what}`)
ok(
  "face's theme names exactly what a native host cannot honor",
  JSON.stringify(named) ===
    JSON.stringify([
      'overlay transition: opacity 150ms ease',
      'focusable outline: none',
      'focusable case focus-visible',
      'control case focus-visible',
    ]),
  JSON.stringify(named),
)
ok('every name carries its reason', light.unlowered.every(miss => miss.why.length > 20), JSON.stringify(light.unlowered.map(m => m.why)))

// the host text: one line, rows by `;`, fields by `|`, no separator inside any value
const text = styleTableText(light)
ok('the host text is one line', !text.includes('\n'), text.slice(0, 80))
ok(
  'the host text carries a state row as class|attribute=value|declaration',
  text.split(';').includes('overlay|data-state=open|opacity: 1') && text.split(';').includes('control|disabled|opacity: 0.5'),
  text,
)
ok('every host row has exactly three fields', text.split(';').every(row => row.split('|').length === 3), text)

// a sheet that reaches every reason a row cannot lower
const odd = compileLookTable({
  file: 'odd.tree',
  text: `tone
  have gap-1, text <0.25rem>

base style
  find body
  have margin, text <0>

face odd
  have padding, text <1em>
  have color, text <rgb(1, 2, 3)>
  have gap, text <var(--gap-9)>
  have width, text <50%>
  have margin, text <4px>
  have height, text <var(--gap-1)>
  case hover
    have opacity, text <0.8>
  case md
    have width, text <320px>
  case group-open
    have opacity, text <1>
`,
})
const reasons = Object.fromEntries(odd.unlowered.map(miss => [`${miss.at} ${miss.what}`, miss.why]))
const has = (key: string, words: string) => !!reasons[key]?.includes(words)
ok('a `base style` rule is named: a host applies classes only', has('base style a selector rule or at-rule', 'classes only'), JSON.stringify(reasons))
ok('an em length is named', has('odd padding: 1em', 'px or rem'), JSON.stringify(reasons))
ok('an rgb() color is named', has('odd color: rgb(1, 2, 3)', 'hex color'), JSON.stringify(reasons))
ok('a token the sheet does not define is named', has('odd gap: var(--gap-9)', 'no token `gap-9`'), JSON.stringify(reasons))
ok('a percentage is named', has('odd width: 50%', 'px or rem'), JSON.stringify(reasons))
ok('a property the host does not lower is named', has('odd margin: 4px', 'does not lower'), JSON.stringify(reasons))
ok('a pseudo-class is named', has('odd case hover', 'pseudo-class'), JSON.stringify(reasons))
ok('a breakpoint is named', has('odd case md', 'breakpoint'), JSON.stringify(reasons))
ok('a group variant is named', has('odd case group-open', 'another node'), JSON.stringify(reasons))
ok('what does lower still lowers beside them', rows(odd, 'odd') === 'height: 4px', rows(odd, 'odd'))

// face's tailwind sheet, all of it: nothing is dropped in silence. Every class either lowers to a row or a state, or
// has something named against it, and the variant is its own field because tailwind's class names hold colons
const TAILWIND = path.join(TERM, 'deck/face/code/style/tailwind.tree')
const tailwindText = readFileSync(TAILWIND, 'utf8')
const tailwind = compileLookTable({ file: TAILWIND, text: tailwindText })
const tailwindDark = compileLookTable({ file: TAILWIND, text: tailwindText }, { scheme: 'dark' })
const namedAt = new Set([...tailwind.unlowered, ...tailwindDark.unlowered].map(miss => miss.at))
// a `dark:` class holds only a `case dark`, so it is empty in the light table by design and must hold rows in the dark
const darkRows = new Set(tailwindDark.classes.filter(c => c.rows.length > 0).map(c => c.name))
const silent = tailwind.classes.filter(
  c => c.rows.length === 0 && c.states.length === 0 && !namedAt.has(c.name) && !darkRows.has(c.name),
)
ok(`no tailwind class is dropped in silence (${tailwind.classes.length} classes)`, silent.length === 0, silent.slice(0, 5).map(c => c.name).join(' '))
const darkOnly = tailwind.classes.filter(c => c.name.startsWith('dark:'))
ok(
  `every dark: class is empty in light and drawn in dark (${darkOnly.length})`,
  darkOnly.length > 0 && darkOnly.every(c => c.rows.length === 0 && (darkRows.has(c.name) || namedAt.has(c.name))),
  darkOnly.filter(c => c.rows.length > 0 || !(darkRows.has(c.name) || namedAt.has(c.name))).slice(0, 5).map(c => c.name).join(' '),
)
const breakpoint = tailwind.unlowered.find(miss => miss.at === 'sm:p-0')
ok('a class name holding a colon is named whole, its variant apart', breakpoint?.variant === 'sm' && breakpoint.what === 'case sm', JSON.stringify(breakpoint))

console.log(`\nlook-table: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
