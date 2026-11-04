// The forms a mill role mints, generated from its `mint` files, so the grammar and the forms cannot drift.
//
//   pnpm term:mill-forms            report: what the generated form modules would become
//   pnpm term:mill-forms --commit   write them
//
// Two roles generate:
//   - note -> deck/base/code/book.tree  (the document dialect's forms)
//   - code -> deck/base/code/lang.tree  (the language's own AST as forms)
//
// Every `mint <name>, like <form>` block becomes a `form <form>`: each `case <field>` a `link <field>, like text`,
// each `case <field>, mint <sub>` a `list <sub's form>`. A form minted in several files keeps the first definition
// (the files agree today; a drift shows up as a diff here). The mill-grammar gate
// (test/compile/mill-grammar.ts) holds each generated role at zero problems, so a mint that gains a case shows up
// there until this is rerun. Reports by default, writes only on --commit.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { TERM_ROOT } from './root'

// anchored to THIS FILE, not the working directory: the pnpm alias runs it from the Term root so the
// `@term/*` path aliases resolve, and a cwd-relative root then pointed four levels too deep.
const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const ROOT = TERM_ROOT
const TERM = TERM_ROOT

function walk(dir: string, into: string[] = []): string[] {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name)

    if (statSync(path).isDirectory()) {
      walk(path, into)
    } else if (name === 'mint.tree') {
      into.push(path)
    }
  }

  return into
}

type Mint = { form: string | undefined; cases: [string, string | undefined][] }

// the head name of a group, and the head of its first child, read with the parser
function head(group: GroupNode): string | undefined {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

function argument(group: GroupNode): GroupNode | undefined {
  const first = group.nodes[1]

  return first?.kind === 'group' ? first : undefined
}

// the value of a `<key> <value>` sibling: `mint x, like y` puts `like` beside `x` because a comma pops one level
function sibling(group: GroupNode, key: string): string | undefined {
  for (const node of group.nodes.slice(2)) {
    if (node.kind === 'group' && head(node) === key) {
      const value = argument(node)

      return value ? head(value) : undefined
    }
  }

  return undefined
}

// Read with the parser, not with a line-anchored regex over blocks split on a `mint` line. There is
// ONE parser for `.tree` (note/project/term/one-parser.md): the split reads a `mint` line inside a `text <...>` literal as
// the start of a block, and the head regex misses a name carrying an interpolation. tree-parser-0010.
function collect(role: string): { mints: Map<string, Mint>; order: string[] } {
  const mints = new Map<string, Mint>()
  const order: string[] = []

  for (const file of walk(join(TERM, 'deck/mill/code/tree', role))) {
    const parsed = parse({ file, text: readFileSync(file, 'utf8') })

    if (!parsed.ok) {
      continue
    }

    for (const group of parsed.tree.nodes) {
      if (head(group) !== 'mint') {
        continue
      }

      const nameGroup = argument(group)
      const name = nameGroup ? head(nameGroup) : undefined

      if (!name) {
        continue
      }

      const form = sibling(group, 'like')
      const cases: [string, string | undefined][] = []

      for (const child of group.nodes.slice(1)) {
        if (child.kind !== 'group' || head(child) !== 'case') {
          continue
        }

        const caseName = argument(child)

        if (caseName && head(caseName)) {
          cases.push([head(caseName)!, sibling(child, 'mint')])
        }
      }

      if (!mints.has(name)) {
        mints.set(name, { form, cases })
      }

      if (form && !order.includes(form)) {
        order.push(form)
      }
    }
  }

  return { mints, order }
}

// the code role names the language's own AST, and a bare head name cannot be a form (`form task` is refused by the
// mill; `like task` is the function type), so a single-word form of that role is spelled `code-<name>` -- the
// scoping the role's newer mints already use (`code-tree`, `code-fuse`, `code-slot`). Hyphenated names are already
// scoped and stay as written.
function formName(role: string, name: string): string {
  return role === 'code' && !name.includes('-') ? `code-${name}` : name
}

function render(role: string, header: string[]): string {
  const { mints, order } = collect(role)
  const forms = new Map<string, [string, string][]>()

  for (const { form, cases } of mints.values()) {
    if (!form || forms.has(form)) {
      continue
    }

    forms.set(
      form,
      cases.map(([field, sub]) => {
        const subForm = sub ? mints.get(sub)?.form : undefined

        return [
          field,
          subForm ? `list ${formName(role, subForm)}` : 'like text',
        ]
      }),
    )
  }

  const lines = [...header, '']

  for (const form of order) {
    lines.push(`form ${formName(role, form)}`)

    for (const [field, like] of forms.get(form) ?? []) {
      lines.push(`  link ${field}, ${like}`)
    }

    lines.push('')
  }

  return lines.join('\n')
}

const TARGETS: { role: string; out: string; header: string[] }[] = [
  {
    role: 'note',
    out: join(TERM, 'deck/base/code/book.tree'),
    header: [
      "# The note dialect's forms: what deck/mill/code/tree/note mints (one form per `mint <x>, like <form>`). A book is the",
      '# document a `.tree` note is, and every head of the note grammar (head, flow, list, code, surf, view, tell, cast,',
      '# wall, film, fuse, bind, load, host, mind, date, term, bold, tilt, line, rise, fall, draw, walk) is one of these.',
      '# Generated by `pnpm term:mill-forms` so the grammar and the forms cannot drift; regenerate when a mint changes.',
    ],
  },
  {
    role: 'code',
    out: join(TERM, 'deck/base/code/lang.tree'),
    header: [
      "# The language's own AST as forms: what deck/mill/code/tree/code mints (one form per `mint <x>, like <form>`).",
      '# Every head of Term (task, form, hold, fork, call, ...) that the self-hosting mill builds is one of these,',
      '# named by its head, scoped where a bare name would collide (`fork-test`, `host-form`, `code-tree`).',
      '# Generated by `pnpm term:mill-forms` so the grammar and the forms cannot drift; regenerate when a mint changes.',
    ],
  },
]

const commit = process.argv.includes('--commit')

for (const target of TARGETS) {
  const text = render(target.role, target.header)
  const current = (() => {
    try {
      return readFileSync(target.out, 'utf8')
    } catch {
      return ''
    }
  })()

  // counted from the parse tree of what was just generated, not with a line-anchored regex, which also counts a line
  // inside a `text <...>` literal. One parser: note/project/term/one-parser.md.
  const generated = parse({ file: target.out, text })
  const formCount = generated.ok
    ? generated.tree.nodes.filter(g => head(g) === 'form').length
    : 0

  if (commit) {
    writeFileSync(target.out, text)
    console.log(`wrote ${relative(ROOT, target.out)}: ${formCount} forms from the ${target.role} role`)
  } else {
    console.log(
      `${target.role}: ${formCount} forms; ${current === text ? `${relative(ROOT, target.out)} is current` : `${relative(ROOT, target.out)} would change (run with --commit)`}`,
    )
  }
}
