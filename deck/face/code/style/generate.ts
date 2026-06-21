// The Tailwind generator: emits a `look` stylesheet (`tailwind.tree`) that is the full atomic utility set, derived
// systematically from the theme scales. The build then compiles that stylesheet to CSS via look-css, exactly like a
// hand-written `face` file. This is how "all of Tailwind" is produced from the small `face` primitive: a generator
// walks family x scale and emits one `face` per cell. Run: `pnpm tsx face/code/style/generate.ts` (writes
// face/code/style/tailwind.tree). Keep the scales here as the single source so tokens and utilities stay in sync.

import { writeFileSync } from 'fs'
import { resolve } from 'path'

// the spacing scale (rem), Tailwind's default ramp. key -> value.
const SPACE: Record<string, string> = {
  '0': '0px',
  px: '1px',
  '0.5': '0.125rem',
  '1': '0.25rem',
  '1.5': '0.375rem',
  '2': '0.5rem',
  '2.5': '0.625rem',
  '3': '0.75rem',
  '3.5': '0.875rem',
  '4': '1rem',
  '5': '1.25rem',
  '6': '1.5rem',
  '7': '1.75rem',
  '8': '2rem',
  '9': '2.25rem',
  '10': '2.5rem',
  '11': '2.75rem',
  '12': '3rem',
  '14': '3.5rem',
  '16': '4rem',
  '20': '5rem',
  '24': '6rem',
  '28': '7rem',
  '32': '8rem',
  '40': '10rem',
  '48': '12rem',
  '56': '14rem',
  '64': '16rem',
  '72': '18rem',
  '80': '20rem',
  '96': '24rem',
}

// fractional + keyword sizes shared by width/height
const FRACTION: Record<string, string> = {
  '1/2': '50%',
  '1/3': '33.333333%',
  '2/3': '66.666667%',
  '1/4': '25%',
  '3/4': '75%',
  full: '100%',
  min: 'min-content',
  max: 'max-content',
  fit: 'fit-content',
  auto: 'auto',
}

// the color palette: hue -> shade -> hex. The semantic tokens (surface, accent, ...) live in theme.tree; this is the
// raw ramp the bg-/text-/border- utilities reference by name.
const PALETTE: Record<string, Record<string, string>> = {
  zinc: {
    '50': '#fafafa',
    '100': '#f4f4f5',
    '200': '#e4e4e7',
    '300': '#d4d4d8',
    '400': '#a1a1aa',
    '500': '#71717a',
    '600': '#52525b',
    '700': '#3f3f46',
    '800': '#27272a',
    '900': '#18181b',
    '950': '#09090b',
  },
  violet: {
    '50': '#f5f3ff',
    '100': '#ede9fe',
    '200': '#ddd6fe',
    '300': '#c4b5fd',
    '400': '#a78bfa',
    '500': '#8b5cf6',
    '600': '#7c3aed',
    '700': '#6d28d9',
    '800': '#5b21b6',
    '900': '#4c1d95',
    '950': '#2e1065',
  },
  emerald: {
    '50': '#ecfdf5',
    '100': '#d1fae5',
    '200': '#a7f3d0',
    '300': '#6ee7b7',
    '400': '#34d399',
    '500': '#10b981',
    '600': '#059669',
    '700': '#047857',
    '800': '#065f46',
    '900': '#064e3b',
    '950': '#022c22',
  },
  rose: {
    '50': '#fff1f2',
    '100': '#ffe4e6',
    '200': '#fecdd3',
    '300': '#fda4af',
    '400': '#fb7185',
    '500': '#f43f5e',
    '600': '#e11d48',
    '700': '#be123c',
    '800': '#9f1239',
    '900': '#881337',
    '950': '#4c0519',
  },
  amber: {
    '50': '#fffbeb',
    '100': '#fef3c7',
    '200': '#fde68a',
    '300': '#fcd34d',
    '400': '#fbbf24',
    '500': '#f59e0b',
    '600': '#d97706',
    '700': '#b45309',
    '800': '#92400e',
    '900': '#78350f',
    '950': '#451a03',
  },
  blue: {
    '50': '#eff6ff',
    '100': '#dbeafe',
    '200': '#bfdbfe',
    '300': '#93c5fd',
    '400': '#60a5fa',
    '500': '#3b82f6',
    '600': '#2563eb',
    '700': '#1d4ed8',
    '800': '#1e40af',
    '900': '#1e3a8a',
    '950': '#172554',
  },
}

const FONT_SIZE: Record<string, string> = {
  xs: '0.75rem',
  sm: '0.875rem',
  base: '1rem',
  lg: '1.125rem',
  xl: '1.25rem',
  '2xl': '1.5rem',
  '3xl': '1.875rem',
  '4xl': '2.25rem',
  '5xl': '3rem',
  '6xl': '3.75rem',
}

const FONT_WEIGHT: Record<string, string> = {
  thin: '100',
  light: '300',
  normal: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
  extrabold: '800',
  black: '900',
}

const RADIUS: Record<string, string> = {
  none: '0px',
  sm: '0.125rem',
  '': '0.25rem',
  md: '0.375rem',
  lg: '0.5rem',
  xl: '0.75rem',
  '2xl': '1rem',
  '3xl': '1.5rem',
  full: '9999px',
}

const SHADOW: Record<string, string> = {
  sm: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  '': '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  md: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
  lg: '0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)',
  xl: '0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)',
  '2xl': '0 25px 50px -12px rgb(0 0 0 / 0.25)',
  none: '0 0 #0000',
}

// a category tags which variants a utility gets (so the catalog is meaningful, not a full 8x cross-product):
// interactive visuals get state variants, layout/spacing get responsive variants, colors also get dark.
type Category = 'color' | 'layout' | 'space' | 'size' | 'type' | 'effect' | 'border' | 'misc'
type Rule = { name: string; decls: [string, string][]; category: Category }

const rules: Rule[] = []
const lines: string[] = []

// one `face` rule with a single declaration
function util(name: string, property: string, value: string, category: Category): void {
  rules.push({ name, decls: [[property, value]], category })
}

// a fixed-value utility from a name -> css map over a property
function family(
  prefix: string,
  property: string,
  scale: Record<string, string>,
  category: Category,
): void {
  for (const [key, value] of Object.entries(scale)) {
    const name = key === '' ? prefix : `${prefix}-${key}`
    util(name, property, value, category)
  }
}

// a multi-declaration utility (display, flex shorthands)
function group(name: string, decls: [string, string][], category: Category): void {
  rules.push({ name, decls, category })
}

function build(): void {
  // spacing: padding / margin (+ per side) and gap
  family('p', 'padding', SPACE, 'space')
  family('px', 'padding-inline', SPACE, 'space')
  family('py', 'padding-block', SPACE, 'space')
  family('pt', 'padding-top', SPACE, 'space')
  family('pr', 'padding-right', SPACE, 'space')
  family('pb', 'padding-bottom', SPACE, 'space')
  family('pl', 'padding-left', SPACE, 'space')
  family('m', 'margin', SPACE, 'space')
  family('mx', 'margin-inline', SPACE, 'space')
  family('my', 'margin-block', SPACE, 'space')
  family('mt', 'margin-top', SPACE, 'space')
  family('mr', 'margin-right', SPACE, 'space')
  family('mb', 'margin-bottom', SPACE, 'space')
  family('ml', 'margin-left', SPACE, 'space')
  family('gap', 'gap', SPACE, 'space')
  family('gap-x', 'column-gap', SPACE, 'space')
  family('gap-y', 'row-gap', SPACE, 'space')

  // sizing
  family('w', 'width', { ...SPACE, ...FRACTION, screen: '100vw' }, 'size')
  family('h', 'height', { ...SPACE, ...FRACTION, screen: '100vh' }, 'size')
  family('min-w', 'min-width', { '0': '0px', full: '100%', min: 'min-content', max: 'max-content' }, 'size')
  family('max-w', 'max-width', { ...FRACTION, none: 'none', xs: '20rem', sm: '24rem', md: '28rem', lg: '32rem', xl: '36rem', '2xl': '42rem' }, 'size')
  family('min-h', 'min-height', { '0': '0px', full: '100%', screen: '100vh' }, 'size')
  family('max-h', 'max-height', { full: '100%', screen: '100vh' }, 'size')

  // colors over the palette
  for (const [hue, shades] of Object.entries(PALETTE)) {
    for (const [shade, hex] of Object.entries(shades)) {
      util(`bg-${hue}-${shade}`, 'background-color', hex, 'color')
      util(`text-${hue}-${shade}`, 'color', hex, 'color')
      util(`border-${hue}-${shade}`, 'border-color', hex, 'color')
      util(`ring-${hue}-${shade}`, '--tw-ring-color', hex, 'color')
      util(`fill-${hue}-${shade}`, 'fill', hex, 'color')
    }
  }
  util('bg-white', 'background-color', '#ffffff', 'color')
  util('bg-black', 'background-color', '#000000', 'color')
  util('bg-transparent', 'background-color', 'transparent', 'color')
  util('text-white', 'color', '#ffffff', 'color')
  util('text-black', 'color', '#000000', 'color')

  // typography
  family('text', 'font-size', FONT_SIZE, 'type')
  family('font', 'font-weight', FONT_WEIGHT, 'type')
  family('leading', 'line-height', { none: '1', tight: '1.25', snug: '1.375', normal: '1.5', relaxed: '1.625', loose: '2' }, 'type')
  family('tracking', 'letter-spacing', { tighter: '-0.05em', tight: '-0.025em', normal: '0em', wide: '0.025em', wider: '0.05em', widest: '0.1em' }, 'type')
  family('text', 'text-align', { left: 'left', center: 'center', right: 'right', justify: 'justify' }, 'type')

  // display + flex/grid
  group('block', [['display', 'block']], 'layout')
  group('inline-block', [['display', 'inline-block']], 'layout')
  group('inline', [['display', 'inline']], 'layout')
  group('flex', [['display', 'flex']], 'layout')
  group('inline-flex', [['display', 'inline-flex']], 'layout')
  group('grid', [['display', 'grid']], 'layout')
  group('hidden', [['display', 'none']], 'layout')
  family('flex', 'flex-direction', { row: 'row', 'row-reverse': 'row-reverse', col: 'column', 'col-reverse': 'column-reverse' }, 'layout')
  family('flex', 'flex-wrap', { wrap: 'wrap', 'wrap-reverse': 'wrap-reverse', nowrap: 'nowrap' }, 'layout')
  family('items', 'align-items', { start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch', baseline: 'baseline' }, 'layout')
  family('justify', 'justify-content', { start: 'flex-start', center: 'center', end: 'flex-end', between: 'space-between', around: 'space-around', evenly: 'space-evenly' }, 'layout')
  family('self', 'align-self', { auto: 'auto', start: 'flex-start', center: 'center', end: 'flex-end', stretch: 'stretch' }, 'layout')
  family('grid-cols', 'grid-template-columns', { '1': 'repeat(1, minmax(0, 1fr))', '2': 'repeat(2, minmax(0, 1fr))', '3': 'repeat(3, minmax(0, 1fr))', '4': 'repeat(4, minmax(0, 1fr))', '5': 'repeat(5, minmax(0, 1fr))', '6': 'repeat(6, minmax(0, 1fr))', '12': 'repeat(12, minmax(0, 1fr))' }, 'layout')

  // borders + radius
  family('rounded', 'border-radius', RADIUS, 'border')
  family('border', 'border-width', { '': '1px', '0': '0px', '2': '2px', '4': '4px', '8': '8px' }, 'border')

  // effects
  family('shadow', 'box-shadow', SHADOW, 'effect')
  const opacity: Record<string, string> = {}
  for (const n of [0, 5, 10, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 95, 100]) opacity[String(n)] = String(n / 100)
  family('opacity', 'opacity', opacity, 'effect')

  // position + layout
  family('', 'position', { static: 'static', fixed: 'fixed', absolute: 'absolute', relative: 'relative', sticky: 'sticky' }, 'misc')
  family('inset', 'inset', { '0': '0px', auto: 'auto', full: '100%' }, 'misc')
  family('z', 'z-index', { '0': '0', '10': '10', '20': '20', '30': '30', '40': '40', '50': '50', auto: 'auto' }, 'misc')
  family('overflow', 'overflow', { auto: 'auto', hidden: 'hidden', visible: 'visible', scroll: 'scroll' }, 'misc')
  family('cursor', 'cursor', { pointer: 'pointer', default: 'default', 'not-allowed': 'not-allowed', wait: 'wait', text: 'text' }, 'misc')
}

// which variants each category gets: interactive visuals get state variants, layout/spacing/sizing/type get responsive
// breakpoints, colors also flip in dark mode. This keeps the catalog useful without an 8x-every-utility explosion.
const VARIANTS_FOR: Record<Category, string[]> = {
  color: ['hover', 'focus', 'active', 'disabled', 'dark', 'md', 'lg'],
  effect: ['hover', 'focus', 'active', 'disabled'],
  border: ['hover', 'focus', 'dark'],
  layout: ['sm', 'md', 'lg', 'xl'],
  space: ['sm', 'md', 'lg'],
  size: ['sm', 'md', 'lg'],
  type: ['sm', 'md', 'lg', 'dark'],
  misc: [],
}

// emit a rule, either as a base utility or under a `<prefix>:` variant class with a `case <prefix>` wrapper
function emit(rule: Rule, prefix: string): void {
  const name = prefix ? `${prefix}:${rule.name}` : rule.name
  lines.push(`face ${name}`)
  const indent = prefix ? '    ' : '  '

  if (prefix) {
    lines.push(`  case ${prefix}`)
  }

  for (const [property, value] of rule.decls) {
    lines.push(`${indent}have ${property}, text <${value}>`)
  }
}

function main(): void {
  build()

  lines.push('')
  lines.push('# GENERATED by face/code/style/generate.ts. Do not edit by hand. The full Tailwind atomic utility set,')
  lines.push('# derived from the theme scales, with responsive + state variants per category. Compiled to CSS by look-css.')

  // base utilities first
  for (const rule of rules) {
    emit(rule, '')
  }

  // then the variant forms (md:flex, hover:bg-x, dark:text-x, ...) per the category map
  let variantCount = 0
  for (const rule of rules) {
    for (const prefix of VARIANTS_FOR[rule.category]) {
      emit(rule, prefix)
      variantCount++
    }
  }

  const out = resolve(
    process.env.FACE_STYLE_DIR ?? process.cwd(),
    'tailwind.tree',
  )
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(
    `generated ${rules.length} base + ${variantCount} variant = ${rules.length + variantCount} utilities -> ${out}`,
  )
}

main()
