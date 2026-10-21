// UNFORGEABLE. `mark hide` on a form: only the file that declares it may make one (term/affine-kinds-0009, decision
// note/project/term/affine-kinds/decision/001-many-by-default-sole-and-hide-declared-per-form.md, section hide).
//
// The form's NAME stays public, so another file writes `like permit` in a signature, reads `permit/note` and matches on
// its cases. Only its MAKING is hidden, and each way to produce one from nothing outside the declaring file is refused
// as `hidden-make`, naming the form and the file that may make it:
//
//   1. `make permit`, or `make <case>` of any of its cases
//   2. `call fill ... / like permit`, a typed read of data into a value whose type holds the form (`melt` is allowed:
//      it makes data from a value, not a value from data)
//   3. a task with no body, or a `dock` binding, whose result type holds the form: each is an axiom that would hand
//      one out from nothing
//
// A file under the package's own `test/` may make one, the same exemption as `mark private` (check/private.ts
// `testOf`). Runs after the checker, so a `fill` carries the type it was read into.
//
// NOT HERE YET (decision 001, hide rule 3): a value of type `unknown` or `dynamic` reaching a place typed by the form
// (`hidden-unknown`), and an unfilled `rule` claim whose result holds the form.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { deckOfList, testOf } from '@term/make/code/check/private'
import type { DeckHome, DeckOf } from '@term/make/code/check/private'

type Form = Extract<Statement, { form: 'record-type' }>

const short = (file: string): string => file.split('/').slice(-3).join('/')

// may `file` make a value of `form`: it declares it, or it is a test of the declaring package
function mayMake(form: Form, file: string | undefined, deckOf?: DeckOf): boolean {
  const home = form.span.file

  if (!home || !file || home === file) {
    return true
  }

  return testOf(file, home, deckOf)
}

// every hidden form a type holds, through lists, hashes, type arguments and function results
function hiddenIn(type: Type | undefined, hidden: Map<string, Form>, into: Form[] = []): Form[] {
  if (!type || typeof type !== 'object') {
    return into
  }

  switch (type.kind) {
    case 'named': {
      const form = hidden.get(type.name)

      if (form && !into.includes(form)) {
        into.push(form)
      }

      for (const arg of type.args ?? []) {
        hiddenIn(arg, hidden, into)
      }

      return into
    }

    case 'array':
      return hiddenIn(type.element, hidden, into)

    case 'map':
      hiddenIn(type.key, hidden, into)

      return hiddenIn(type.value, hidden, into)

    case 'function':
      return hiddenIn(type.result, hidden, into)

    default:
      return into
  }
}

function refusal(form: Form, file: string, span: Span, how: string): Diagnostic {
  const home = form.span.file ? short(form.span.file) : 'its own file'

  return diagnose('hidden-make', {
    file,
    span: { ...span, file },
    message: `"${form.name}" is \`mark hide\` in ${home}, so ${short(file)} cannot ${how}: only ${home} makes one`,
    markers: [{ span: { ...span, file } }, { span: form.span, label: `hidden form "${form.name}" here` }],
    hint: `get a ${form.name} from a task in ${home} that makes one, or remove \`mark hide\` from ${form.name}`,
  })
}

// every node under a statement, each object once (a lowered program shares subtrees). Types, spans and the kernel's
// copies of a body hold no construction a backend emits
function eachNode(node: unknown, visit: (record: Record<string, unknown>) => void, seen: WeakSet<object> = new WeakSet()): void {
  if (!node || typeof node !== 'object' || seen.has(node)) {
    return
  }

  seen.add(node)

  if (Array.isArray(node)) {
    for (const item of node) {
      eachNode(item, visit, seen)
    }

    return
  }

  const record = node as Record<string, unknown>
  visit(record)

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared' && key !== 'stubBody' && key !== 'stubShape') {
      eachNode(value, visit, seen)
    }
  }
}

export function checkHiddenMakes(program: Program, file: string, decks: DeckHome[]): Diagnostic[] {
  const hidden = new Map<string, Form>()

  for (const s of program) {
    if (s.form === 'record-type' && s.hide) {
      hidden.set(s.name, s)
    }
  }

  if (hidden.size === 0) {
    return []
  }

  // every form by name, and the forms that own each case name, so `make <case>` finds its form
  const forms = new Map<string, Form>()
  const owners = new Map<string, Form[]>()

  for (const s of program) {
    if (s.form === 'record-type') {
      forms.set(s.name, s)

      for (const variant of s.variants ?? []) {
        const list = owners.get(variant.name) ?? []
        list.push(s)
        owners.set(variant.name, list)
      }
    }
  }

  // the form a `make <name>` builds: the form of that name, else the form owning a case of that name (the one the
  // construction's `owner` names, where two forms share the case)
  const builtBy = (name: string, owner: string | undefined): Form[] => {
    const own = forms.get(name)

    if (own && (own.variants ?? []).length === 0) {
      return [own]
    }

    const cased = (owners.get(name) ?? []).filter(form => !owner || form.name === owner)

    return cased.length > 0 ? cased : own ? [own] : []
  }

  const deckOf = deckOfList(decks)
  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()

  const refuse = (form: Form, from: string, span: Span, how: string): void => {
    const key = `${from}\u0000${span.start.line}\u0000${span.start.column}\u0000${form.name}`

    if (!told.has(key)) {
      told.add(key)
      diagnostics.push(refusal(form, from, span, how))
    }
  }

  for (const top of program) {
    const from = top.span.file ?? file

    // 3. a declaration that hands one out from nothing
    if (top.form === 'function' && !top.stub && top.body.length === 0 && !top.claim) {
      for (const form of hiddenIn(top.result ?? undefined, hidden)) {
        if (!mayMake(form, from, deckOf)) {
          refuse(form, from, top.span, `declare "${top.name.replace(/__.*$/, '')}", a task with no body that answers one`)
        }
      }
    }

    if (top.form === 'bind') {
      for (const form of hiddenIn(top.result ?? undefined, hidden)) {
        if (!mayMake(form, from, deckOf)) {
          refuse(form, from, top.span, `bind "${top.name}", a host binding that answers one`)
        }
      }
    }

    if (top.form === 'record-type') {
      continue
    }

    eachNode(top, node => {
      // 1. `make permit`, or a case of it
      if (node.form === 'record' && typeof node.name === 'string' && node.span) {
        const owner = typeof node.owner === 'string' ? node.owner : undefined

        for (const form of builtBy(node.name, owner)) {
          if (form.hide && !mayMake(form, from, deckOf)) {
            const what = node.name === form.name ? `make a ${form.name}` : `make a ${form.name} (its case "${node.name}")`
            refuse(form, from, node.span as Span, what)
          }
        }
      }

      // 2. `call fill ... / like permit`: a typed read of data into one
      if (node.form === 'call' && node.span) {
        const callee = node.callee as { form?: string; name?: string } | undefined

        if (callee?.form === 'variable' && callee.name === 'fill') {
          for (const form of hiddenIn(node.type as Type | undefined, hidden)) {
            if (!mayMake(form, from, deckOf)) {
              refuse(form, from, node.span as Span, `fill a ${form.name} from data`)
            }
          }
        }
      }
    })
  }

  return diagnostics
}
