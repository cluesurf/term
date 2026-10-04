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
import { typeKey } from '@term/make/code/compile/node'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { ImportScope } from '@term/make/code/compile/load'
import { nestLeanCalls } from '@term/make/code/check/lean-nest'
import { HTML_TAGS } from '@term/make/code/compile/view-lower'

// same-name, same-arity overloads: the first candidate's (mangled) name -> every candidate's name. Filled here,
// read by the checker, which picks the candidate whose parameter types fit the arguments (check/infer.ts,
// chooseOverload). A call is mangled to the first candidate so the resolver finds a definition; the checker
// re-targets it once the argument types are known.
export const overloadGroups = new Map<string, string[]>()

// the keys bindByImport added to `overloadGroups` for a call several imported (or no imported) files take at different
// types: their members are remapped once the arity pass has renamed any of them (disambiguateOverloads)
const typedChoices = new Set<string>()

type Definition = Extract<Statement, { form: 'function' }>

// a parameter's shape for comparing two same-arity definitions. An untyped parameter and `unknown` are the same
// wildcard, so a per-environment shim that re-declares a task with a looser or tighter type is an OVERRIDE (the last
// one wins, as before), never an overload.
const shape = (d: Definition): (string | undefined)[] =>
  d.params.map(p => (p.type && p.type.kind !== 'unknown' ? typeKey(p.type) : undefined))

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

// Every name BOUND inside a node: parameters (of the task itself and of any closure in it), `save` locals, a walk's
// item and index, and a case arm's renamed fields. This pass runs before the resolver, so no call carries a binding
// yet, and a call to a name bound here is a call to that LOCAL, which shadows every top-level definition.
//
// Without it, `maybe/filter`'s `call test / read value`, where `test` is the task's own callback parameter, was
// refused as ambiguous between the stdlib's `file/test` and the CLI's `work/app-verbs` `test`: a question about
// imports asked of a call that names no import at all. It broke `@term/call`'s build and `pnpm term:cli-drift`
// (found 2026-10-02 by the self-hosting work, note/term/self-host/).
//
// Over the WHOLE top-level statement rather than by block, which over-approximates in the safe direction: a call to
// a global that a local of the same name hides elsewhere in the same task is left unbound, and fails later as a
// visible unknown name rather than binding wrongly in silence.
function boundIn(node: unknown, into = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') {
    return into
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      boundIn(item, into)
    }

    return into
  }

  const record = node as Record<string, unknown>

  // a let, and a view's own computed local (`save total / ...` in a component body)
  if ((record.form === 'let' || record.form === 'save') && typeof record.name === 'string') {
    into.add(record.name)
  }

  // a walk's item, in code (`for-each`) and in a view (`walk`)
  if (record.form === 'for-each' || record.form === 'walk') {
    for (const key of ['item', 'index']) {
      if (typeof record[key] === 'string') {
        into.add(record[key] as string)
      }
    }
  }

  if (Array.isArray(record.params)) {
    for (const param of record.params as { name?: unknown }[]) {
      if (typeof param?.name === 'string') {
        into.add(param.name)
      }
    }
  }

  if (Array.isArray(record.binds)) {
    for (const name of record.binds) {
      if (typeof name === 'string') {
        into.add(name)
      }
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared' && key !== 'generics') {
      boundIn(value, into)
    }
  }

  return into
}

// TWO MODULES DEFINING ONE NAME (native-dom-0031, module-scope-0002). A name belongs to the module that defines it and
// reaches another module only through `load ... / find` (note/term/project/module-scope.md). The build still merges
// every module into one flat program, so without this pass two definitions of one name from two files met in it: of
// one signature, the one merged last won in silence (`from-text` became the bytes module's in a dispatcher that meant
// json's, the stdlib's own `remove` was a file's or a directory's by load order); of two signatures, they became
// overloads of one global name, so a call bound to a module its file never imported.
//
// So every name with bodied definitions in two or more files is split BY FILE: each file's definitions take a name of
// their own (`<name>__in<g>_<k>`), and the definitions of one file keep sharing it, so overloads WITHIN a file are
// still chosen by arity and type in the pass below. The entry file's own keep their original name, which is what its
// roots and its exported API are called. Each reference is then bound by WHAT ITS OWN FILE IMPORTED:
//
//   its own file's definitions, else the files its `load ... / find <name>` reached (or their `bear` chains)
//   one such file      the reference is that file's
//   several            the one whose definitions take the call's arity, else refused naming the files
//   none (unimported)  the one file whose definitions take the arity, else refused with the `find` to add
//
// A call is a reference, and so is a task passed as a value (a `variable` that is no local). A signature with no body
// (an abstract declaration, a stub, a claim) is never a candidate, so it is still overridden by its implementation,
// which the env chain relies on. Without a scope (one file, no resolver) only the arity can tell.
function bindByImport(program: Program, scope: ImportScope | undefined, entry?: string): Diagnostic[] {
  // a task, or a component (module-scope-0004): both are called, both are placed or passed, both are split by file
  type Bindable = Definition | Extract<Statement, { form: 'view' }>
  type Group = { name: string; index: number; files: string[]; byFile: Map<string, Bindable[]>; renamed: Map<string, string> }
  const groups = new Map<string, Group>()
  const bindable = new Map<string, Bindable[]>()

  for (const s of program) {
    if (s.form === 'function' || s.form === 'view') {
      bindable.set(s.name, [...(bindable.get(s.name) ?? []), s])
    }
  }

  for (const [name, list] of bindable) {
    const defs = list.filter(d => d.span.file && (d.form === 'view' || (d.body.length > 0 && !d.stub && !d.claim && !d.method)))
    const byFile = new Map<string, Bindable[]>()

    for (const d of defs) {
      byFile.set(d.span.file!, [...(byFile.get(d.span.file!) ?? []), d])
    }

    if (byFile.size > 1) {
      groups.set(name, { name, index: groups.size, files: [...byFile.keys()].sort(), byFile, renamed: new Map() })
    }
  }

  if (groups.size === 0) {
    return []
  }

  ;[...groups.values()].forEach((group, g) =>
    group.files.forEach((file, k) => {
      const renamed = file === entry ? group.name : `${group.name}__in${g}_${k}`
      group.renamed.set(file, renamed)
      group.byFile.get(file)!.forEach(d => (d.name = renamed))
    }),
  )

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

  // the files of a group a reference in `file` reaches: its own, else those its imports reach
  const reached = (group: Group, file: string | undefined): string[] => {
    if (!file) {
      return []
    }

    if (group.byFile.has(file)) {
      return [file]
    }

    const reach = new Set<string>()

    for (const target of scope?.get(file)?.finds.get(group.name) ?? []) {
      exported(target, reach)
    }

    return group.files.filter(f => reach.has(f))
  }

  // the files among `files` with a definition that takes `arity` arguments (a component's parameters are all required)
  const taking = (group: Group, files: string[], arity: number): string[] =>
    files.filter(f =>
      group.byFile.get(f)!.some(d => {
        const required = d.form === 'view' ? d.params.length : d.params.filter(p => !p.optional).length

        return arity >= required && arity <= d.params.length
      }),
    )

  const diagnostics: Diagnostic[] = []
  const told = new Set<string>()
  const short = (file: string) => file.split('/').slice(-3).join('/')

  // refuse a reference that cannot be told, once per file and name
  const refuse = (group: Group, file: string | undefined, span: Span, among: string[], imported: boolean): void => {
    const key = `${file}\u0000${group.name}`

    if (told.has(key)) {
      return
    }

    told.add(key)
    const here = file ? short(file) : 'this file'
    diagnostics.push(
      diagnose('duplicate-definition', {
        file,
        span,
        message: imported
          ? `${here} imports "${group.name}" from more than one file that defines it (${among.map(short).join(', ')}), so the reference cannot tell which it means`
          : `"${group.name}" is defined in ${among.length} files (${among.map(short).join(', ')}) and ${here} imports it from none of them, so the reference cannot tell which it means`,
        markers: [
          { span },
          ...among.flatMap(f => group.byFile.get(f)!.map(d => ({ span: d.span, label: `a "${group.name}" here` }))),
        ],
        hint: `add \`find ${group.name}\` under the \`load\` of the one ${here} means. A name belongs to the module that defines it`,
      }),
    )
  }

  // the name a reference with `arity` arguments (undefined: a task passed as a value) in `file` binds to, or undefined
  const bind = (group: Group, file: string | undefined, arity: number | undefined, span: Span): string | undefined => {
    const imported = reached(group, file)

    // the file imported the name from a module that defines it some OTHER way (a form's method, as `stream.tree`'s
    // `find contains` from the list, or a signature an env fills): it means that one, never this group's, and is left
    // as written for the resolver to find there
    const asked = (file && scope?.get(file)?.finds.get(group.name)) || []

    if (imported.length === 0 && asked.length > 0) {
      return undefined
    }

    const candidates = imported.length > 0 ? imported : group.files
    const fit = arity === undefined ? candidates : taking(group, candidates, arity)

    if (imported.length === 1) {
      return group.renamed.get(imported[0]!)
    }

    if (fit.length === 1) {
      return group.renamed.get(fit[0]!)
    }

    // nothing takes this arity: left for the checker's own arity diagnostic against what the file reaches
    if (fit.length === 0 && arity !== undefined) {
      return group.renamed.get(candidates[0]!)
    }

    // several files take the arity at DIFFERENT parameter types: the checker picks among exactly those by the
    // arguments' types, as it picked among a global name's overloads before. Its own key, never a member's name, so a
    // call that bound to one member directly is not drawn into the choice. Same types cannot be told apart that way,
    // and are refused. Until the strict step (module-scope-0006) refuses an unimported call outright
    if (arity !== undefined && fit.length > 1) {
      const firsts = fit.map(f => group.byFile.get(f)![0]!)
      const typedApart = firsts.some((a, i) =>
        firsts.slice(i + 1).some(b => a.form === 'function' && b.form === 'function' && differ(a, b)),
      )

      if (typedApart) {
        const key = `${group.name}__any${group.index}_${arity}`
        overloadGroups.set(key, [...new Set(fit.map(f => group.renamed.get(f)!))])
        typedChoices.add(key)

        return key
      }
    }

    refuse(group, file, span, fit.length > 0 ? fit : candidates, imported.length > 0)

    return undefined
  }

  // the top-level values that are neither tasks nor components (a `host` constant, a dock alias, a bind): a variable
  // naming one of these is that value, not a task passed as a value, even where tasks of the same name collide
  const values = new Set(
    program.flatMap(s => (s.form === 'let' || s.form === 'bind' ? [s.name] : s.form === 'native' ? [s.alias] : [])),
  )

  // every field name of every form and variant. Inside a `fork case` arm the variant's fields are locals by their own
  // names, which no binding in the tree records, so a variable named like a field may be one: `read start` in the clock's
  // `case mark / link start` arm is the field, not the file's own task `start` (native/node/clock/measurement.tree). A
  // value reference with a field's name is left as written, as every value reference was before
  const fields = new Set(
    program.flatMap(s =>
      s.form === 'record-type' ? [...s.fields.map(f => f.name), ...s.variants.flatMap(v => v.fields.map(f => f.name))] : [],
    ),
  )

  for (const top of program) {
    const file = top.span.file
    // the names a local binds inside this statement, which shadow every definition of the group (boundIn)
    const local = boundIn(top)

    eachReference(top, (variable, arity) => {
      const group = groups.get(variable.name)

      if (
        !group ||
        local.has(variable.name) ||
        (arity === undefined && (values.has(variable.name) || fields.has(variable.name)))
      ) {
        return
      }

      const name = bind(group, file, arity, variable.span)

      if (name) {
        variable.name = name
      }
    })
  }

  return diagnostics
}

// A `host` VALUE AND A TASK OF ONE NAME IN TWO FILES (terminal-target-0003). `bindByImport` splits a task or a component
// defined in two files and leaves a top-level value alone, so a `host focus` in one module (the terminal host's focus
// record) and a `task focus` in another (the memory dom's) reached the TypeScript output as two declarations of `focus`,
// and the bundle refused to load. A value is already told from a call by where its name stands (`read focus` is the
// value, `call focus` the task), so the value is renamed apart, and every VALUE reference in a file that can see it
// follows: the file that defines it, and any file whose `find` of the name reaches that file through the `bear` chain.
// A call, and a value reference anywhere else, keeps the name, which is the task's.
function bindValuesApart(program: Program, scope: ImportScope | undefined): void {
  const callable = new Map<string, Set<string>>()

  for (const s of program) {
    if ((s.form === 'function' || s.form === 'view') && s.span.file) {
      callable.set(s.name, (callable.get(s.name) ?? new Set()).add(s.span.file))
    }
  }

  const hosts = program.filter(
    (s): s is Extract<Statement, { form: 'let' }> =>
      s.form === 'let' && Boolean(s.span.file) && [...(callable.get(s.name) ?? [])].some(file => file !== s.span.file),
  )

  // a file and everything it re-exports with `bear`, transitively
  const exported = (file: string, into = new Set<string>()): Set<string> => {
    if (!into.has(file)) {
      into.add(file)
      ;(scope?.get(file)?.bears ?? []).forEach(next => exported(next, into))
    }

    return into
  }

  hosts.forEach((host, i) => {
    const original = host.name
    const home = host.span.file!
    const renamed = `${original}__value${i}`
    const sees = (file: string): boolean =>
      file === home || (scope?.get(file)?.finds.get(original) ?? []).some(target => exported(target).has(home))

    host.name = renamed

    for (const top of program) {
      if (top === host || !top.span.file || !sees(top.span.file)) {
        continue
      }

      const local = boundIn(top)

      eachReference(top, (variable, arity) => {
        if (arity === undefined && variable.form === 'variable' && variable.name === original && !local.has(original)) {
          variable.name = renamed
        }
      })
    }
  })
}

// every reference to a name under a node: a call's callee with its argument count, and any other variable (a task passed
// as a value) with none. Generic over the tree, as eachCall is
function eachReference(
  node: unknown,
  visit: (variable: Extract<Expression, { form: 'variable' }>, arity: number | undefined) => void,
): void {
  if (!node || typeof node !== 'object') {
    return
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      eachReference(item, visit)
    }

    return
  }

  const record = node as Record<string, unknown>

  if (record.form === 'call' && (record.callee as { form?: string } | undefined)?.form === 'variable') {
    visit(record.callee as Extract<Expression, { form: 'variable' }>, (record.args as unknown[]).length)

    for (const arg of record.args as unknown[]) {
      eachReference(arg, visit)
    }

    return
  }

  if (record.form === 'variable' && typeof record.name === 'string') {
    visit(record as Extract<Expression, { form: 'variable' }>, undefined)

    return
  }

  // a component placed in a view (`view <name>`), unless it is a standard HTML tag, which is always the element
  // (view-lower.ts HTML_TAGS), or a `node <name>` forcing the element. Bound as a value: it has props, not an arity
  if (record.form === 'element' && typeof record.name === 'string' && !record.forced && !HTML_TAGS.has(record.name)) {
    visit(record as unknown as Extract<Expression, { form: 'variable' }>, undefined)
  }

  for (const [key, value] of Object.entries(record)) {
    if (key !== 'span' && key !== 'type' && key !== 'result' && key !== 'declared' && key !== 'generics') {
      eachReference(value, visit)
    }
  }
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

// A LEAN LABEL NAMING A TASK, READ AS THE NESTED CALL IT IS, before anything is renamed (check/lean-nest.ts).
//
// The resolver does this too, later, where the scope is known. But the import binding below renames every task of an
// ambiguous name apart (`replace` becomes `replace__from3_1`), so by the time the resolver looks, a label spelled
// `replace` names nothing callable and stays a label: `"replace__from3_1" has no parameter "replace"` in
// deck/site/code/http/http.tree (`pnpm term:lean-equal`, 2026-10-02). Done here, the nested call is an ordinary call
// when the binding runs, and is renamed with every other call to the name.
//
// Only under a call to a TASK the program defines, whose parameters are therefore known. A construction's labels are
// its fields, and a field may share a task's name, so those are left to the checker.
function nestLeanLabels(program: Program): void {
  const definitions = definitionsOf(program)

  for (const top of program) {
    const local = boundIn(top)

    eachCall(top, call => {
      const callee = (call.callee as { name: string }).name
      const defs = definitions.get(callee)

      if (!defs) {
        return
      }

      const params = new Set(defs.flatMap(d => d.params.map(p => p.name)))

      nestLeanCalls(
        call,
        name => params.has(name),
        name => definitions.has(name) || local.has(name),
      )
    })
  }
}

// Returns the references it could not bind: see bindByImport. `entry` is the file whose own definitions keep their
// names when a name is split by file, because its roots and its exported API are called by them.
export function disambiguateOverloads(program: Program, scope?: ImportScope, entry?: string): Diagnostic[] {
  overloadGroups.clear()
  typedChoices.clear()

  nestLeanLabels(program)
  bindSiblingMethods(program)
  bindValuesApart(program, scope)

  const ambiguities = bindByImport(program, scope, entry)

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

  // how many definitions of each name the ENTRY file holds. One that is its file's only definition of the name keeps
  // the name, as `bindByImport` keeps it: the entry's roots and exported API are called by it. A program whose `run`
  // shared its name with the db module's two-argument `run` emitted `run0`, and its host found no `run` to call
  // (terminal-target-0005, 2026-10-03). The other arities still take their suffixes, so no two names collide
  const ownedByEntry = new Map<string, number>()

  for (const s of program) {
    if (entry && s.form === 'function' && s.span.file === entry) {
      ownedByEntry.set(s.name, (ownedByEntry.get(s.name) ?? 0) + 1)
    }
  }

  for (const s of program) {
    if (s.form === 'function' && overloaded.has(s.name)) {
      const original = s.name
      const base = mangle(s.name, s.params.length)
      let group: string | undefined

      if (entry && s.span.file === entry && ownedByEntry.get(original) === 1 && !typed.has(base)) {
        // the entry's one definition keeps its name; every other arity is mangled, so the names stay apart
      } else if (typed.has(base)) {
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

  // a typed choice bindByImport made names members before this pass renamed the overloaded ones by arity: each such
  // member stands for every definition it was renamed into
  for (const key of typedChoices) {
    const members = overloadGroups.get(key) ?? []
    overloadGroups.set(key, [...new Set(members.flatMap(member => ranges.get(member)?.map(r => r.name) ?? [member]))])
  }

  return ambiguities
}
