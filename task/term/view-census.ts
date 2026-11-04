// The view census (view-vocabulary-0001): every element tag, attribute, event and layout pattern the two real view
// programs use today, counted off the compiler's own parse. The programs are the blog
// (deck/site/test/site/face/blog.tree) and form.surf (mesh/site/form.surf/home/site/**/*.tree).
//
// It is the census and NOT the vocabulary: it says what is written, so the vocabulary (view-vocabulary-0002) can be
// argued against a count rather than a guess.
//
// What is counted, per file and in total:
//
//   placements   every `view <name>` and `zone <name>` (form.surf still writes the pre-2026-08-30 `zone` spelling)
//                under a definition. A name some scanned file DEFINES, or LOADS with `find`, is a component; every
//                other name is an element tag
//   attributes   `bind <name>` directly under a placement, per tag or component
//   events       `seed <name>` directly under a placement
//   content      `text <...>` (static), `read` (dynamic) and `name` (a ref) directly under a placement
//   structure    `walk` (a list) and `fork` (a branch) anywhere inside a definition
//   classes      every whitespace-separated token of a `bind class` value, grouped by what it lays out
//
// Usage:
//   pnpm term:view-census            print the census
//   pnpm term:view-census --commit   also write it into note/project/term/view/11-vocabulary.md between its markers

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// by path: `@term/deck` has no alias in the Term root's tsconfig, and the reader is the one shared flattening of a parse
import { readTree } from '../../deck/deck/code/package/read'
import type { Form } from '../../deck/deck/code/package/read'
import { TERM_ROOT, parentRoot } from './root'

const ROOT = TERM_ROOT
const BLOG = join(TERM_ROOT, 'deck/site/test/site/face/blog.tree')
const FORM_SURF = (): string => join(parentRoot(), 'mesh/site/form.surf/home/site')
const NOTE = (): string => join(parentRoot(), 'note/project/term/view/11-vocabulary.md')
const START = '<!-- census:start -->'
const END = '<!-- census:end -->'

// the heads that place an element or a component: `view` today, `zone` before 2026-08-30
const PLACE_HEADS = new Set(['view', 'zone'])

// a class token's layout family, by prefix: what each one asks a host to do
const CLASS_FAMILIES: [string, RegExp][] = [
  ['direction', /^(flex|flex-col|flex-row|inline-flex)$/],
  ['alignment', /^(items|justify|self|content|place)-/],
  ['growth', /^(flex-grow|flex-1|grow|shrink)/],
  ['gap', /^gap-/],
  ['padding', /^p[xytblr]?-/],
  ['margin', /^m[xytblr]?-/],
  ['size', /^(w|h|min-w|min-h|max-w|max-h)-/],
  ['grid', /^grid/],
  ['position', /^(relative|absolute|fixed|sticky|z-)/],
  ['text', /^text-/],
]

type Count = Map<string, number>

type Census = {
  files: string[]
  tags: Count
  components: Count
  attributes: Map<string, Count>
  events: Map<string, Count>
  content: Count
  structure: Count
  classes: Map<string, Count>
}

function bump(count: Count, key: string): void {
  count.set(key, (count.get(key) ?? 0) + 1)
}

function bumpIn(nested: Map<string, Count>, outer: string, inner: string): void {
  const count = nested.get(outer) ?? new Map<string, number>()
  bump(count, inner)
  nested.set(outer, count)
}

function treeFiles(dir: string): string[] {
  const found: string[] = []

  for (const name of readdirSync(dir)) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      found.push(...treeFiles(path))
    } else if (name.endsWith('.tree')) {
      found.push(path)
    }
  }

  return found.sort()
}

// the names a file brings in with `load ... / find <name>` (or `find <name>, name <alias>`, which binds the alias)
function loadedNames(forms: Form[]): Set<string> {
  const names = new Set<string>()

  for (const form of forms) {
    if (form.head !== 'load') {
      continue
    }

    for (const found of form.forms.filter(f => f.head === 'find')) {
      const alias = found.forms.find(f => f.head === 'name')?.terms[0]
      const name = alias ?? found.terms[0]

      if (name) {
        names.add(name)
      }
    }
  }

  return names
}

// the class tokens of a `bind class, text <...>`
function classTokens(form: Form): string[] {
  const value = form.forms.find(f => f.head === 'text')?.value ?? ''

  return value.split(/\s+/).filter(Boolean)
}

function familyOf(token: string): string {
  return CLASS_FAMILIES.find(([, pattern]) => pattern.test(token))?.[0] ?? 'other'
}

// walk one placement and everything under it
function visit(form: Form, components: Set<string>, census: Census): void {
  if (form.head === 'walk' || form.head === 'fork') {
    bump(census.structure, form.head)
  }

  const name = PLACE_HEADS.has(form.head) ? form.terms[0] : undefined

  if (name) {
    bump(components.has(name) ? census.components : census.tags, name)

    for (const child of form.forms) {
      if (child.head === 'bind' && child.terms[0]) {
        bumpIn(census.attributes, name, child.terms[0])

        if (child.terms[0] === 'class') {
          for (const token of classTokens(child)) {
            bumpIn(census.classes, familyOf(token), token)
          }
        }
      } else if (child.head === 'seed' && child.terms[0]) {
        bumpIn(census.events, name, child.terms[0])
      } else if (child.head === 'text') {
        bump(census.content, 'text (static)')
      } else if (child.head === 'read') {
        bump(census.content, 'read (dynamic)')
      } else if (child.head === 'name') {
        bump(census.content, 'name (a ref the code reads the node by)')
      }
    }
  }

  for (const child of form.forms) {
    visit(child, components, census)
  }
}

function takeCensus(files: string[]): Census {
  const census: Census = {
    files,
    tags: new Map(),
    components: new Map(),
    attributes: new Map(),
    events: new Map(),
    content: new Map(),
    structure: new Map(),
    classes: new Map(),
  }
  const parsed = files.map(file => {
    const result = readTree({ file, text: readFileSync(file, 'utf8') })

    if (!result.ok) {
      throw new Error(`${relative(ROOT, file)} does not parse: ${result.diagnostics.map(d => d.message).join(', ')}`)
    }

    return result.forms
  })

  // a component is a name some scanned file defines at the top level, or loads
  const components = new Set<string>()

  for (const forms of parsed) {
    loadedNames(forms).forEach(name => components.add(name))

    for (const form of forms) {
      if (PLACE_HEADS.has(form.head) && form.terms[0]) {
        components.add(form.terms[0])
      }
    }
  }

  // `view` and `dom`-style host names loaded for their tasks are not components a page places
  for (const forms of parsed) {
    for (const form of forms) {
      // a top-level definition: its body holds the placements
      if (PLACE_HEADS.has(form.head)) {
        for (const child of form.forms) {
          visit(child, components, census)
        }
      }
    }
  }

  return census
}

function sorted(count: Count): [string, number][] {
  return [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

function total(count: Count): number {
  return [...count.values()].reduce((sum, n) => sum + n, 0)
}

function table(header: [string, string], rows: [string, number][]): string[] {
  if (rows.length === 0) {
    return ['none']
  }

  return [`| ${header[0]} | ${header[1]} |`, '| --- | --- |', ...rows.map(([key, n]) => `| \`${key}\` | ${n} |`)]
}

function render(census: Census): string {
  const lines: string[] = []
  const attributeRows = [...census.attributes].flatMap(([owner, count]) =>
    sorted(count).map(([attribute, n]) => [`${owner} ${attribute}`, n] as [string, number]),
  )
  const eventRows = [...census.events].flatMap(([owner, count]) =>
    sorted(count).map(([event, n]) => [`${owner} ${event}`, n] as [string, number]),
  )

  lines.push(
    '## The census, not the vocabulary',
    '',
    'Generated by `pnpm term:view-census --commit` (`task/term/view-census.ts`) from the compiler\'s own parse. It',
    'counts what the two real view programs WRITE today, so the vocabulary below it can be argued against a count.',
    'A name a scanned file defines or loads is a component. Every other placed name is an element tag.',
    '',
    `Files, ${census.files.length}:`,
    '',
    ...census.files.map(file => `- \`${relative(ROOT, file)}\``),
    '',
    `### Element tags: ${census.tags.size} distinct, ${total(census.tags)} placements`,
    '',
    ...table(['tag', 'placements'], sorted(census.tags)),
    '',
    `### Components placed: ${census.components.size} distinct, ${total(census.components)} placements`,
    '',
    ...table(['component', 'placements'], sorted(census.components)),
    '',
    `### Attributes: ${attributeRows.length} distinct pairs`,
    '',
    ...table(['placed name and attribute', 'uses'], attributeRows.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    '',
    `### Events: ${eventRows.length} distinct pairs`,
    '',
    ...table(['placed name and event', 'uses'], eventRows),
    '',
    '### Content',
    '',
    ...table(['kind', 'uses'], sorted(census.content)),
    '',
    '### Structure',
    '',
    ...table(['construct', 'uses'], sorted(census.structure)),
    '',
    `### Layout, from class tokens: ${[...census.classes.values()].reduce((sum, c) => sum + c.size, 0)} distinct tokens`,
    '',
  )

  for (const [family] of CLASS_FAMILIES.concat([['other', /$^/]])) {
    const count = census.classes.get(family)

    if (!count) {
      continue
    }

    lines.push(`${family}: ${sorted(count).map(([token, n]) => `\`${token}\` ${n}`).join(', ')}`, '')
  }

  return lines.join('\n').trimEnd()
}

const census = takeCensus([BLOG, ...treeFiles(FORM_SURF())])
const text = render(census)
console.log(text)

if (process.argv.includes('--commit')) {
  const block = `${START}\n${text}\n${END}`
  const current = existsSync(NOTE()) ? readFileSync(NOTE(), 'utf8') : ''
  const next =
    current.includes(START) && current.includes(END)
      ? current.replace(new RegExp(`${START}[\\s\\S]*${END}`), block)
      : `${current.trimEnd()}${current ? '\n\n' : ''}${block}\n`
  writeFileSync(NOTE(), next)
  console.log(`\nwritten to ${relative(ROOT, NOTE())}`)
}
