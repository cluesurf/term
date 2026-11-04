// The reference pages of @term/base: one page per module marked `note stable`, listing every public form (its fields)
// and every public task (its parameters, their types, what it answers, and the comment written above it), read with
// the compiler's own parser so a page cannot claim what the module does not declare. Reports which pages would change
// by default; `--commit` writes them to note/project/term/stdlib/draft/reference/, with an index. `pnpm term:base-reference`.

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import type { Type } from '@term/make/code/compile/node'
import { TERM_ROOT, parentRoot } from './root'

const here = dirname(fileURLToPath(import.meta.url))
const code = join(TERM_ROOT, 'deck/base/code')
const out = join(parentRoot(), 'note/project/term/stdlib/draft/reference')
const commit = process.argv.includes('--commit')
const skipped = new Set(['native', 'hold', 'proof', '.build', 'node_modules'])

function walk(dir: string, into: string[] = []): string[] {
  if (existsSync(join(dir, 'draft.tree'))) {
    return into
  }

  for (const name of readdirSync(dir)) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      if (!skipped.has(name)) {
        walk(path, into)
      }
    } else if (name.endsWith('.tree') && name !== 'draft.tree') {
      into.push(path)
    }
  }

  return into
}

// a type as Term writes it
function typeText(type: Type | undefined): string {
  if (!type) {
    return 'unknown'
  }

  switch (type.kind) {
    case 'number':
      return 'number'
    case 'float':
      return 'decimal'
    case 'string':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'bytes':
      return 'bytes'
    case 'unit':
      return 'void'
    case 'array':
      return `list of ${typeText(type.element)}`
    case 'map':
      return `hash of ${typeText(type.key)} to ${typeText(type.value)}`
    case 'named':
      return type.args?.length ? `${type.name} of ${type.args.map(typeText).join(', ')}` : type.name
    case 'function':
      return `task (${type.params.map(typeText).join(', ')}) to ${typeText(type.result)}`
    case 'variable':
      return 'any'
    default:
      return type.kind
  }
}

// the `#` lines directly above a top-level `task <name>` or `form <name>`
function comments(text: string): Map<string, string> {
  const found = new Map<string, string>()
  const lines = text.split('\n')

  lines.forEach((line, i) => {
    const head = /^(task|form|bind) ([\w-]+)$/.exec(line)

    if (!head) {
      return
    }

    const above: string[] = []

    for (let k = i - 1; k >= 0 && lines[k]!.startsWith('#'); k--) {
      above.unshift(lines[k]!.replace(/^#\s?/, ''))
    }

    if (above.length) {
      found.set(head[2]!, above.join(' '))
    }
  })

  return found
}

// a module's first comment block, the summary at the top of its page
function summary(text: string): string {
  const lines: string[] = []

  for (const line of text.split('\n')) {
    if (line.startsWith('#')) {
      lines.push(line.replace(/^#\s?/, ''))
    } else if (lines.length || line.trim()) {
      break
    }
  }

  return lines.join(' ')
}

function page(module: string, text: string): string | undefined {
  const parsed = parse({ file: module, text })

  if (!parsed.ok) {
    return undefined
  }

  const built = mill(expandTemplates(parsed.tree), module)

  if (!built.ok) {
    return undefined
  }

  const notes = comments(text)
  const rows: string[] = [`# ${module}`, '']
  const top = summary(text)

  if (top) {
    rows.push(top, '')
  }

  rows.push(`\`load @term/base/code/${module}\``, '')

  const forms = built.program.filter(n => n.form === 'record-type') as {
    name: string
    fields: { name: string; type: Type }[]
    variants: { name: string; fields: { name: string; type: Type }[] }[]
  }[]

  if (forms.length) {
    rows.push('## Forms', '', '| form | fields |', '| --- | --- |')

    for (const form of forms) {
      const fields = form.variants.length
        ? form.variants.map(v => `\`${v.name}\`${v.fields.length ? ` (${v.fields.map(f => `${f.name}: ${typeText(f.type)}`).join(', ')})` : ''}`).join(', or ')
        : form.fields.map(f => `${f.name}: ${typeText(f.type)}`).join(', ')
      rows.push(`| \`${form.name}\` | ${fields || 'none'} |`)
    }

    rows.push('')
  }

  const tasks = built.program.filter(n => (n.form === 'function' && !n.private) || n.form === 'bind') as {
    form: string
    name: string
    params: { name: string; type?: Type; optional?: boolean }[]
    result?: Type
  }[]

  if (tasks.length) {
    rows.push('## Tasks', '', '| task | takes | answers | what |', '| --- | --- | --- | --- |')

    for (const task of tasks) {
      const takes = task.params.map(p => `${p.name}: ${typeText(p.type)}${p.optional ? ' (optional)' : ''}`).join(', ')
      const what = (notes.get(task.name) ?? '').replace(/\|/g, '\\|')
      rows.push(`| \`${task.name}\` | ${takes || 'none'} | ${typeText(task.result)} | ${what} |`)
    }

    rows.push('')
  }

  return rows.join('\n')
}

const pages = new Map<string, string>()

for (const file of walk(code).sort()) {
  const text = readFileSync(file, 'utf8')

  if (!text.split('\n').slice(0, 60).includes('note stable')) {
    continue
  }

  const module = relative(code, file).replace(/\.tree$/, '')
  const body = page(module, text)

  if (body) {
    pages.set(module, body)
  } else {
    console.log(`unread   ${module}`)
  }
}

const index = [
  '# @term/base reference',
  '',
  `Generated by \`pnpm term:base-reference --commit\` from the ${pages.size} modules marked \`note stable\`. Do not edit these pages: edit the module and generate again. The meaning each backend shares is in [../semantics.md](../semantics.md).`,
  '',
  '| module | page |',
  '| --- | --- |',
  ...[...pages.keys()].map(m => `| \`${m}\` | [${m}](${m.replace(/\//g, '--')}.md) |`),
  '',
].join('\n')

let changed = 0

for (const [module, body] of [...pages, ['readme', index] as const]) {
  const path = join(out, `${module.replace(/\//g, '--')}.md`)
  const now = existsSync(path) ? readFileSync(path, 'utf8') : undefined

  if (now !== body) {
    changed++

    if (commit) {
      mkdirSync(out, { recursive: true })
      writeFileSync(path, body)
    }
  }
}

console.log(`base-reference: ${pages.size} modules, ${changed} pages ${commit ? 'written' : 'would change (run with --commit)'}`)
