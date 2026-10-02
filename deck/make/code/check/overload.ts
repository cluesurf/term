// Arity overloading: two functions may share a name if they take different numbers of parameters (e.g. `to-string` and
// `to-string(radix)`). This pass disambiguates them BEFORE resolution and type checking, purely structurally (a call's
// arity is its argument count, known without inference): each overloaded definition is renamed `name__<arity>`, and
// every call to it is rewritten to the matching arity. Downstream (resolve, check, every backend) then sees unique
// names and needs no overloading logic. Same-name same-arity definitions are NOT renamed, so a genuine duplicate is
// still reported by the checker. Pure, browser-safe; mutates the program in place.

import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import { showType } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { ImportScope } from '@term/make/code/compile/load'

// same-name, same-arity overloads: the first candidate's (mangled) name -> every candidate's name. Filled here,
// read by the checker, which picks the candidate whose parameter types fit the arguments (check/infer.ts,
// chooseOverload). A call is mangled to the first candidate so the resolver finds a definition; the checker
// re-targets it once the argument types are known.
export const overloadGroups = new Map<string, string[]>()

type Definition = Extract<Statement, { form: 'function' }>

// a parameter's shape for comparing two same-arity definitions. An untyped parameter and `unknown` are the same
// wildcard, so a per-environment shim that re-declares a task with a looser or tighter type is an OVERRIDE (the last
// one wins, as before), never an overload.
const shape = (d: Definition): (string | undefined)[] =>
  d.params.map(p => (p.type && p.type.kind !== 'unknown' ? showType(p.type) : undefined))

const differ = (a: Definition, b: Definition): boolean => {
  const sa = shape(a)
  const sb = shape(b)

  return sa.some((t, i) => t !== undefined && sb[i] !== undefined && t !== sb[i])
}

// every definition of each name
function definitionsOf(program: Program): Map<string, Definition[]> {
  const definitions = new Map<string, Definition[]>()

  for (const s of program) {
    if (s.form === 'function') {
      const list = definitions.get(s.name) ?? []
      list.push(s)
      definitions.set(s.name, list)
    }
  }

  return definitions
}

// every call to a bare name anywhere under a node. Generic over the tree so no statement or expression form is
// missed; types, spans and signatures hold no calls a definition could be named by.
function eachCall(node: unknown, visit: (call: Extract<Expression, { form: 'call' }>) => void): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      eachCall(item, visit)
    }

    return
  }

  const record = node as Record<string, unknown>

  if (record.form === 'call' && (record.callee as { form?: string } | undefined)?.form === 'variable') {
    visit(record as Extract<Expression, { form: 'call' }>)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared' && key !== 'generics') {
      eachCall(value, visit)
    }
  }
}

// TWO MODULES DEFINING ONE NAME (native-dom-0031). Names are package-global, so two definitions of one name, both with
// bodies, from two files, that neither arity nor parameter types tell apart, used to leave every call bound to
// whichever was merged last, in silence: `from-text` became the bytes module's in a dispatcher that meant json's, a
// test's `mount` became the browser dom's, and the stdlib's own `remove` was a file's or a directory's by load order.
//
// Each such definition is renamed apart, and each call is bound by WHAT ITS OWN FILE IMPORTED: the definition in the
// calling file itself, or else the one in the file its `load ... / find <name>` resolved to (or that file re-exports
// with `bear`). A call whose file imports the name from none of them, or from more than one, is refused, naming the
// files. A signature with no body (an abstract declaration, a stub, a claim) is not a candidate, so it is still
// overridden by its implementation, which is what the env chain relies on. Without a scope (one file, no resolver)
// there is nothing to bind by, and every call to such a name is refused.
function bindByImport(program: Program, scope: ImportScope | undefined): Diagnostic[] {
  const groups: { name: string; min: number; max: number; defs: Definition[]; files: string[] }[] = []

  for (const [name, list] of definitionsOf(program)) {
    for (const arity of new Set(list.map(d => d.params.length))) {
      const defs = list.filter(
        d => d.params.length === arity && d.body.length > 0 && !d.stub && !d.claim && !d.method,
      )
      const files = [...new Set(defs.map(d => d.span.file).filter((f): f is string => !!f))]

      if (files.length < 2 || defs.some((a, i) => defs.slice(i + 1).some(b => differ(a, b)))) {
        continue
      }

      groups.push({ name, min: defs[0]!.params.filter(p => !p.optional).length, max: arity, defs, files })
    }
  }

  if (groups.length === 0) {
    return []
  }

  groups.forEach((group, g) => group.defs.forEach((d, k) => (d.name = `${group.name}__from${g}_${k}`)))

  // a file and everything it re-exports with `bear`, transitively
  const exported = (file: string, into = new Set<string>()): Set<string> => {
    if (into.has(file)) {
      return into
    }

    into.add(file)

    for (const next of scope?.get(file)?.bears ?? []) {
      exported(next, into)
    }

    return into
  }

  // the definition a call in `file` means, `elsewhere` when its import reaches another definition of the name that is
  // not in this group (a list's `contains` beside text's two), or undefined when it cannot be told
  const choose = (
    group: (typeof groups)[number],
    file: string | undefined,
  ): Definition | 'elsewhere' | undefined => {
    if (!file) {
      return undefined
    }

    const own = group.defs.filter(d => d.span.file === file)

    if (own.length === 1) {
      return own[0]
    }

    const reach = new Set<string>()

    for (const target of scope?.get(file)?.finds.get(group.name) ?? []) {
      exported(target, reach)
    }

    const hits = group.defs.filter(d => d.span.file !== undefined && reach.has(d.span.file))

    if (hits.length === 0 && reach.size > 0) {
      return 'elsewhere'
    }

    return hits.length === 1 ? hits[0] : undefined
  }

  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()
  const short = (file: string) => file.split('/').slice(-3).join('/')

  for (const top of program) {
    const file = top.span.file

    eachCall(top, call => {
      const callee = call.callee as Extract<Expression, { form: 'variable' }>
      const group = groups.find(
        g => g.name === callee.name && call.args.length >= g.min && call.args.length <= g.max,
      )

      if (!group) {
        return
      }

      const pick = choose(group, file)

      // imported from a module that defines the name some other way: the arity and type overloading below has it
      if (pick === 'elsewhere') {
        return
      }

      if (pick) {
        callee.name = pick.name

        return
      }

      const key = `${file}\u0000${group.name}`

      if (told.has(key)) {
        return
      }

      told.add(key)
      const imported = file ? (scope?.get(file)?.finds.get(group.name) ?? []) : []
      diagnostics.push(
        diagnose('duplicate-definition', {
          file,
          span: call.span,
          message: `"${group.name}" is defined in ${group.files.length} files (${group.files.map(short).join(', ')}), and ${file ? short(file) : 'this file'} imports it from ${imported.length ? `${imported.map(short).join(', ')}, which reaches more than one of them` : 'none of them'}, so the call cannot tell which it means`,
          markers: [{ span: call.span }, ...group.defs.map(d => ({ span: d.span, label: `a "${group.name}" here` }))],
          hint: `add \`find ${group.name}\` under the \`load\` of the one this file means. Names are package-global, so a definition another import brings in is otherwise as visible as the one you loaded`,
        }),
      )
    })
  }

  return diagnostics
}

// A FORM'S METHOD CALLING A SIBLING BY ITS BARE NAME (native-dom-0036). A method is callable by its bare name only while
// no top-level task has that name (check/resolve.ts, buildGlobalScope), so a top-level `remove` in ANY module took every
// `call remove / read self / read key` inside the hash form's own methods, and `hash/clear` was refused at hash.tree in
// a program that never called it. Inside a method of form F, a bare call that names a method of F, passes `self` first
// and fits that method's arity is the sibling, and is rewritten to the sibling's full name. Only where a top-level task
// shadows the sibling, so nothing else moves.
function bindSiblingMethods(program: Program): void {
  const methods = new Map<string, Map<string, Definition>>()
  const plain = new Set<string>()

  for (const s of program) {
    if (s.form !== 'function') {
      continue
    }

    if (s.method) {
      const forForm = methods.get(s.method.form) ?? new Map<string, Definition>()
      forForm.set(s.method.name, s)
      methods.set(s.method.form, forForm)
    } else {
      plain.add(s.name)
    }
  }

  for (const s of program) {
    if (s.form !== 'function' || !s.method) {
      continue
    }

    const siblings = methods.get(s.method.form)!

    eachCall(s.body, call => {
      const callee = call.callee as Extract<Expression, { form: 'variable' }>
      const sibling = siblings.get(callee.name)
      const first = call.args[0]

      if (
        sibling &&
        plain.has(callee.name) &&
        first?.form === 'variable' &&
        first.name === 'self' &&
        call.args.length >= sibling.params.filter(p => !p.optional).length &&
        call.args.length <= sibling.params.length
      ) {
        callee.name = sibling.name
      }
    })
  }
}

// Returns the calls it could not bind: see bindByImport.
export function disambiguateOverloads(program: Program, scope?: ImportScope): Diagnostic[] {
  overloadGroups.clear()

  bindSiblingMethods(program)

  const ambiguities = bindByImport(program, scope)

  // every definition of each name, after the import binding renamed the ambiguous ones apart
  const definitions = definitionsOf(program)

  // a name is overloaded when it is defined at more than one arity, or more than once at one arity with parameter
  // types that differ at some position
  const overloaded = new Set<string>()
  const typed = new Set<string>()

  for (const [name, list] of definitions) {
    const arities = new Set(list.map(d => d.params.length))

    if (arities.size > 1) {
      overloaded.add(name)
    }

    for (const arity of arities) {
      const same = list.filter(d => d.params.length === arity)

      if (same.some((a, i) => same.slice(i + 1).some(b => differ(a, b)))) {
        overloaded.add(name)
        typed.add(`${name}__${arity}`)
      }
    }
  }

  if (overloaded.size === 0) {
    return ambiguities
  }

  const mangle = (name: string, arity: number): string =>
    overloaded.has(name) ? `${name}__${arity}` : name

  // rename each overloaded definition by its parameter count, and a same-arity typed overload by its index too
  const seen = new Map<string, number>()
  // each definition's final name with its accepted argument range, for the call rewrite below
  const ranges = new Map<string, { name: string; min: number; max: number; group?: string }[]>()

  for (const s of program) {
    if (s.form === 'function' && overloaded.has(s.name)) {
      const original = s.name
      const base = mangle(s.name, s.params.length)
      let group: string | undefined

      if (typed.has(base)) {
        const index = seen.get(base) ?? 0
        seen.set(base, index + 1)
        s.name = `${base}__${index}`
        group = `${base}__0`

        const list = overloadGroups.get(group) ?? []
        list.push(s.name)
        overloadGroups.set(group, list)
      } else {
        s.name = base
      }

      const list = ranges.get(original) ?? []
      list.push({
        name: s.name,
        min: s.params.filter(p => !p.optional).length,
        max: s.params.length,
        group,
      })
      ranges.set(original, list)
    }
  }

  // the definition a call with `arity` arguments targets: the one whose accepted range holds it, an exact arity
  // winning a tie; a typed same-arity group targets its first candidate until the checker re-targets it
  const target = (name: string, arity: number): string => {
    const list = ranges.get(name) ?? []
    const fits = list.filter(r => arity >= r.min && arity <= r.max)
    const exact = fits.find(r => r.max === arity)
    const pick = exact ?? fits[0]

    if (!pick) {
      return mangle(name, arity)
    }

    return pick.group ?? pick.name
  }

  // rewrite every call to an overloaded name to the overload matching its argument count
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (
          node.callee.form === 'variable' &&
          overloaded.has(node.callee.name)
        ) {
          node.callee.name = target(node.callee.name, node.args.length)
        }

        expr(node.callee)
        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
        break
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'template':
        for (const part of node.parts) {
          if (typeof part !== 'string') {
            expr(part)
          }
        }

        break
      case 'array':
        node.items.forEach(expr)
        break
      case 'map':
        node.entries.forEach(e => {
          expr(e.key)
          expr(e.value)
        })
        break
      case 'record':
        node.fields.forEach(f => expr(f.value))
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })

        if (node.otherwise) {
          expr(node.otherwise)
        }

        break
      case 'closure':
        node.body.forEach(stmt)
        break
      default:
        break
    }
  }

  const stmt = (node: Statement): void => {
    switch (node.form) {
      case 'let':
        expr(node.init)
        break
      case 'assign':
        expr(node.target)
        expr(node.value)
        break
      case 'expression':
        expr(node.expr)
        break
      case 'return':
        if (node.value) {
          expr(node.value)
        }

        break
      case 'throw':
        expr(node.value)
        break
      case 'hold':
        expr(node.expr)
        break
      case 'while':
        expr(node.cond)
        node.body.forEach(stmt)
        break
      case 'guard':
        node.body.forEach(stmt)
        node.catch?.body.forEach(stmt)
        break
      case 'for-each':
        expr(node.iterable)
        node.body.forEach(stmt)
        break
      case 'if':
        node.branches.forEach(b => {
          expr(b.cond)
          b.body.forEach(stmt)
        })
        node.otherwise?.forEach(stmt)
        break
      case 'match':
        expr(node.subject)
        node.cases.forEach(c => c.body.forEach(stmt))
        node.otherwise?.forEach(stmt)
        break
      case 'function':
        node.body.forEach(stmt)
        break
      default:
        break
    }
  }

  for (const s of program) {
    stmt(s)
  }

  return ambiguities
}
