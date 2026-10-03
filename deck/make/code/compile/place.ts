// F4 (note/term/codegen/readme.md): a record in a list, updated IN PLACE. The value semantics (D1) say
//
//   save b, call get(bodies, i)
//   save bodies/{i}, make body / bind x, read b/x / bind vx, <new> / ...
//
// builds a new record and puts it in the slot. On TypeScript and Kotlin, where a record is an object, that is one
// allocation per write: n-body writes 25 per step, and ran at 4.5 times its hand-written twin on TypeScript, which
// writes `b.vx -= ...`. The write may assign the changed fields of the object already in the slot instead, when no
// one can see the difference: nothing else holds that object, and nothing reads the old value of a changed field
// after the write. Two facts decide it.
//
// 1. A form's values are SLOT-PRIVATE (`privateForms`): a value of the form only ever lives in one place. It is made
//    fresh (a `make`, or a task every return of which is one), enters a list only fresh (a push, a slot write, a list
//    literal), leaves one only into a local, a field read or a `send back`, and is never copied to a second name,
//    passed (unless fresh), captured, nested in another type or written field by field. And every list of the form is
//    an owned local or a lent parameter (F1's facts), so no list of it is ever copied either: a copy would share its
//    elements. Then an element of a list is held by that list's slot and by locals read out of it, and by nothing else.
//
// 2. A write is IN PLACE (`placeWrites`): `bodies/{i}` gets a `make` of the form, and an earlier local in the same
//    block, `b`, was read from `bodies/{i}` with the same index, with nothing between that could have changed the
//    slot, the list or the index. The `make`'s fields that are `b/<same field>` are unchanged; the rest are assigned
//    on `b`. After the write, `b` may be read only for an unchanged field, and so may any other local read from the
//    same list, unless its index is provably a different one (`j` made as `i + 1` and only ever counted up, with `i`
//    not written meanwhile: the pair loop of every n-body). Otherwise the write stays a `make`.
//
// Rust and Swift do not read it: a Rust or Swift record is a value already, and a slot write of one allocates nothing.

import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'
import { gatedTasks, listFacts, ownedLocals, type Lend } from '@term/make/code/compile/backend'

type Fn = Extract<Statement, { form: 'function' }>
type Loose = Record<string, unknown> & { form?: string }

// one write made in place: the local that holds the slot's object, and the fields it assigns, in the `make`'s order.
// `temps` when a value reads something an earlier assignment of the same write changes, so every value is computed
// first
export type PlaceWrite = { local: string; fields: { name: string; value: Expression }[]; temps: boolean }

// both facts for a whole program, as an emitter reads them: the writes made in place, and the forms some write
// updates (Kotlin declares their fields `var`)
export function recordPlaces(program: Program): { writes: Map<Statement, PlaceWrite>; forms: Set<string> } {
  const maskMethods = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, maskMethods))
  const writes = placeWrites(program, privateForms(program, lend, fresh))
  const forms = new Set<string>()

  for (const [write] of writes) {
    const list = ((write as Extract<Statement, { form: 'assign' }>).target as Loose).target as Loose
    const element = ((list.type as Type | undefined) as { element?: Type } | undefined)?.element

    if (element?.kind === 'named') {
      forms.add(element.name)
    }
  }

  return { writes, forms }
}

// the same for a backend whose records are VALUES (Swift's structs): no form needs to be slot-private, since a copy
// held elsewhere cannot see a write, so every plain record form is read for its writes and its slot locals
export function valuePlaces(program: Program): { writes: Map<Statement, PlaceWrite>; locals: Map<Statement, SlotLocal> } {
  const forms = new Set(
    program.flatMap(n =>
      n.form === 'record-type' && !n.params.length && !n.variants.length && n.fields.length && !n.shared && !n.alias ? [n.name] : [],
    ),
  )
  const locals = new Map<Statement, SlotLocal>()
  const writes = placeWrites(program, forms, locals)

  return { writes, locals }
}

const named = (t: Type | undefined, forms: Set<string>): string | undefined =>
  t?.kind === 'named' && forms.has(t.name) && !(t.args ?? []).length ? t.name : undefined

const elementOf = (t: Type | undefined, forms: Set<string>): string | undefined =>
  t?.kind === 'array' ? named(t.element, forms) : undefined

// every form name a type mentions, at any depth
function mentions(t: unknown, into: Set<string>): void {
  if (typeof t !== 'object' || t === null) {
    return
  }

  if (Array.isArray(t)) {
    t.forEach(x => mentions(x, into))

    return
  }

  const node = t as { kind?: string; name?: string }

  if (node.kind === 'named' && typeof node.name === 'string') {
    into.add(node.name)
  }

  for (const child of Object.values(node)) {
    mentions(child, into)
  }
}

// the stdlib's list read, `list/get` or `list/at`, by its method tag: a call to it is a slot read
const listMethod = (fns: Map<string, Fn>, callee: Loose, names: string[]): boolean => {
  if (callee.form !== 'variable') {
    return false
  }

  const of = (fns.get(callee.name as string) as { method?: { form: string; name: string } } | undefined)?.method

  return of?.form === 'list' && names.includes(of.name)
}

// a slot read of a list variable: `xs/{i}`, `xs/0`, `get(xs, i)`. Answers the list and the index, a variable's name
// or a literal, or undefined for an index of any other shape
type Slot = { list: string; index: { name: string } | { value: number } | undefined }

function slotRead(fns: Map<string, Fn>, node: Loose | undefined): Slot | undefined {
  if (!node) {
    return undefined
  }

  const key = (e: Loose | undefined): Slot['index'] =>
    e?.form === 'variable' ? { name: e.name as string } : e?.form === 'integer' ? { value: e.value as number } : undefined

  if (node.form === 'member') {
    const target = node.target as Loose

    if (target.form !== 'variable' || (target.type as Type | undefined)?.kind !== 'array') {
      return undefined
    }

    if (node.index !== undefined) {
      return { list: target.name as string, index: key(node.index as Loose) }
    }

    if (/^\d+$/.test(node.name as string)) {
      return { list: target.name as string, index: { value: Number(node.name) } }
    }

    return undefined
  }

  if (node.form === 'call' && listMethod(fns, node.callee as Loose, ['get', 'at'])) {
    const [list, at] = node.args as Loose[]

    return list?.form === 'variable' ? { list: list.name as string, index: key(at) } : undefined
  }

  // the collection operation, `xs.at(i)`, which the stdlib's `get` inlines to
  if (node.form === 'call' && (node.callee as Loose).form === 'member') {
    const callee = node.callee as Loose
    const list = callee.target as Loose

    if (
      (callee.name === 'at' || callee.name === 'get') &&
      callee.index === undefined &&
      list.form === 'variable' &&
      (list.type as Type | undefined)?.kind === 'array'
    ) {
      return { list: list.name as string, index: key((node.args as Loose[])[0]) }
    }
  }

  return undefined
}

// the forms whose values are slot-private (fact 1)
export function privateForms(
  program: Program,
  lend: Map<string, Map<number, Lend>>,
  fresh: Set<string>,
  // told each refusal, with the task it is in and the rule's line, for a test or a probe to say why
  explain?: (form: string, where: string) => void,
  // the places a record reuse needs (`recordReuse`): nodes judged as allowed where they stand, and the CARRIER forms,
  // whose field of a candidate form does not make that form nested
  allow?: { nodes: WeakSet<object>; carriers: Set<string> },
): Set<string> {
  const fns = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))
  const candidates = new Set<string>()

  for (const n of program) {
    if (n.form === 'record-type' && !n.params.length && !n.variants.length && n.fields.length && !n.shared && !n.alias) {
      candidates.add(n.name)
    }
  }

  const refused = new Set<string>()
  let task = ''
  const refuse = (name: string | undefined): void => {
    if (name && candidates.has(name)) {
      explain?.(name, `${task} ${new Error().stack?.split('\n')[2]?.trim() ?? ''}`)
      refused.add(name)
    }
  }

  // a type that names a candidate anywhere but as the whole type or a list's element
  const nested = (t: Type | undefined): void => {
    if (!t || named(t, candidates) || elementOf(t, candidates)) {
      return
    }

    const seen = new Set<string>()
    mentions(t, seen)
    seen.forEach(name => candidates.has(name) && refuse(name))
  }

  // a form's own fields, and every other form's: a field of the form makes it nested in a record
  for (const n of program) {
    if (n.form === 'record-type' && !allow?.carriers.has(n.name)) {
      for (const f of [...n.fields, ...n.variants.flatMap(v => v.fields)]) {
        const seen = new Set<string>()
        mentions(f.type, seen)
        seen.forEach(name => candidates.has(name) && refuse(name))
      }
    } else if (n.form === 'let') {
      // a module-level value of the form, or a list of it
      const seen = new Set<string>()
      mentions(n.type ?? n.init.type, seen)
      seen.forEach(name => candidates.has(name) && refuse(name))
    }
  }

  // the tasks every return of which is a fresh record of the form: a `make`, or a call to another such task
  const freshForm = new Set<string>()
  const made = (e: Loose | undefined): boolean =>
    e?.form === 'record' ||
    (e?.form === 'call' && (e.callee as Loose).form === 'variable' && freshForm.has((e.callee as Loose).name as string))

  for (let changed = true; changed; ) {
    changed = false

    for (const fn of fns.values()) {
      if (freshForm.has(fn.name) || !named(fn.result, candidates) || fn.generics?.length) {
        continue
      }

      const returns: Loose[] = []
      const collect = (value: unknown): void => {
        if (typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(collect)

          return
        }

        const node = value as Loose

        if (node.form === 'closure') {
          return
        }

        if (node.form === 'return') {
          returns.push((node.value as Loose | undefined) ?? {})
        }

        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            collect(child)
          }
        }
      }

      collect(fn.body)

      if (returns.length && returns.every(r => made(r))) {
        freshForm.add(fn.name)
        changed = true
      }
    }
  }

  // every expression of the form, or a list of it, judged by where it stands
  for (const fn of fns.values()) {
    task = fn.name
    const owned = fn.async ? new Map<string, boolean>() : ownedLocals(fn, fresh, lend)
    const lent = lend.get(fn.name)
    const lentNames = new Set(fn.params.flatMap((p, i) => (lent?.has(i) ? [p.name] : [])))

    for (const p of fn.params) {
      nested(p.type)
    }

    nested(fn.result)

    const visit = (value: unknown, parent: Loose | undefined, key: string, inClosure: boolean): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach(v => visit(v, parent, key, inClosure))

        return
      }

      const node = value as Loose
      const t = (node.form === 'let' ? (node.type ?? (node.init as Loose).type) : node.type) as Type | undefined

      if (node.form === 'let') {
        nested(t)
      }

      if (node.form === 'for-each') {
        nested(((node.iterable as Loose).type as Type | undefined))
      }

      if (node.form === 'assign') {
        const target = node.target as Loose

        // a field written one at a time, or a local of the form rebound
        if (target.form === 'member' && named((target.target as Loose).type as Type, candidates) && target.index === undefined) {
          refuse(named((target.target as Loose).type as Type, candidates))
        }

        if (target.form === 'variable') {
          refuse(named(target.type as Type, candidates) ?? elementOf(target.type as Type, candidates))
        }
      }

      // a collection operation on a list of the form: a slot read (`at`, `get`), a push, a length. Anything else could
      // copy the list or hand an element out (`slice`, `pop`, `map`), and its result is typed `unknown`, past judging
      const callee = node.form === 'call' ? (node.callee as Loose) : undefined
      const onList = callee?.form === 'member' ? elementOf((callee.target as Loose).type as Type, candidates) : undefined

      if (onList && !['at', 'get', 'push', 'length', 'size'].includes(callee!.name as string)) {
        refuse(onList)
      }

      // a generic task given a list of the form sees its elements as a type variable, past judging: only the stdlib's
      // slot read and push, or one answering a scalar (a length, a count, a test)
      const generic = callee?.form === 'variable' ? fns.get(callee.name as string) : undefined

      if (generic?.generics?.length) {
        const lists = (node.args as Loose[]).flatMap(a => {
          const element = elementOf(a.type as Type, candidates) ?? named(a.type as Type, candidates)

          return element ? [element] : []
        })
        const scalar = ['number', 'float', 'boolean', 'string'].includes((t as { kind?: string } | undefined)?.kind ?? '')

        if (lists.length && !scalar && !listMethod(fns, callee!, ['get', 'at', 'push'])) {
          lists.forEach(refuse)
        }
      }

      // a slot read answers the element, whatever type the operation was given
      const form = named(t, candidates) ?? (onList && (callee!.name === 'at' || callee!.name === 'get') ? onList : undefined)
      const list = elementOf(t, candidates)
      const isExpression = node.form !== undefined && node.form !== 'let' && node.form !== 'assign' && parent !== undefined

      if (isExpression && (form || list) && inClosure) {
        refuse(form ?? list)
      }

      // a task named as a callee carries its own signature, which may answer the form: that is the call's type, judged
      // where the call stands
      if (isExpression && key !== 'callee') {
        nested(t)
      }

      if (isExpression && form && !inClosure) {
        judge(form, node, parent!, key)
      }

      if (isExpression && list && !inClosure) {
        judgeList(list, node, parent!, key)
      }

      const closure = inClosure || node.form === 'closure'

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span' && k !== 'declared') {
          visit(child, node, k, closure)
        }
      }
    }

    // a value of the form, at one place
    const judge = (form: string, node: Loose, parent: Loose, key: string): void => {
      const fresh = made(node)

      if (allow?.nodes.has(node)) {
        return
      }

      switch (parent.form) {
        case 'member':
          // a field read; a subscript on a record is not one
          if (key !== 'target' || parent.index !== undefined) {
            refuse(form)
          }

          return
        case 'let':
          // a local of the form: made here, a call, or a slot read. Never a second name for one already held
          if (node.form !== 'record' && node.form !== 'call' && !slotRead(fns, node)) {
            refuse(form)
          }

          return
        case 'return':
          return
        case 'binary':
          // `is-equal` on two records compares their fields
          if (parent.op !== '==' && parent.op !== '!=') {
            refuse(form)
          }

          return
        case 'call': {
          if (key === 'callee') {
            refuse(form)

            return
          }

          const callee = parent.callee as Loose
          const target = callee.form === 'variable' ? fns.get(callee.name as string) : undefined

          // into a list, or into a task's parameter, only fresh; never into a generic task, which could keep it twice
          if (!fresh || (target?.generics?.length && !listMethod(fns, callee, ['push']))) {
            refuse(form)
          }

          return
        }
        case 'assign':
          // the slot written, or the value written to it, fresh
          if (key === 'target' ? !slotRead(fns, node) : !fresh) {
            refuse(form)
          }

          return
        case 'array':
          if (!fresh) {
            refuse(form)
          }

          return
        default:
          refuse(form)
      }
    }

    // a list of the form: by name, an owned local or a lent parameter; otherwise a list made here
    const judgeList = (form: string, node: Loose, parent: Loose, key: string): void => {
      if (node.form === 'variable') {
        const name = node.name as string

        if (!owned.has(name) && !lentNames.has(name)) {
          refuse(form)
        }

        return
      }

      const empty =
        (node.form === 'array' && (node.items as unknown[]).length === 0) ||
        (node.form === 'record' && node.name === 'list' && !(node.fields as unknown[]).length)
      const made =
        node.form === 'array' ||
        empty ||
        (node.form === 'call' && (node.callee as Loose).form === 'variable' && fresh.has((node.callee as Loose).name as string))

      // a list made here is the init of an owned local, or a fresh task's answer
      if (!made || (parent.form !== 'let' && parent.form !== 'return') || key === 'target') {
        refuse(form)
      }
    }

    visit(fn.body, undefined, 'body', false)
  }

  return new Set([...candidates].filter(name => !refused.has(name)))
}

// RECORD REUSE (Perceus's in-place update, for the backends whose records are objects: TypeScript and Kotlin). AWFY's
// Bounce writes every ball back through a task that answers a new one:
//
//   host moved, call move-ball(balls/{k})
//   save balls/{k}, read moved/ball
//
// and on Kotlin each new ball stored into the list was the cost, 614 ms against 198 with the ball changed in place
// (the hand version 151, `tmp/kotlin-bounce-ab.ts`). The object read from the slot dies at the call: the slot is
// written with the result at once, and nothing else holds it. So the task may build its result in that object.
//
// An ELIGIBLE task takes one record of a plain form F (the others scalars), reads it only by field, and every return is
// a `make F`, or a `make G` of a CARRIER form whose one field of type F is a `make F` and whose other fields are
// scalars. A REUSE SITE passes `xs/{i}` there and writes `xs/{i}` with the result at once: in the same statement
// (`save xs/{i}, call t(xs/{i})`), or in the next one from the carrier's field, the carrier read afterwards only for
// its other fields. And F, and the carrier, must still be slot-private (`privateForms`) with those places allowed, so
// no second name for the object exists anywhere. A site calls the task's reusing copy (`<task>-reuse`), which computes
// every field of the result first, then assigns them on the object it was given and answers it
export type Reuse = {
  // each reusing task: the parameter position, its form, and the record nodes of its returns the copy builds in place.
  // With a carrier of two fields, `keep` is the other one (a scalar) and `carriers` its returned records: the copy
  // answers that field alone, since the record it built is already back in the caller's slot
  tasks: Map<string, { param: number; form: string; builds: WeakSet<object>; keep?: { field: string; type: Type }; carriers?: WeakSet<object> }>
  // with a kept field: each carrier `let` at a site, to the field it now holds alone, and each write-back, which the
  // copy has already made
  locals: WeakMap<object, string>
  writeBacks: WeakSet<object>
  // each call made at a reuse site
  sites: WeakSet<object>
  // the forms some copy assigns in place (Kotlin declares their fields `var`)
  forms: Set<string>
}

export function recordReuse(program: Program): Reuse {
  const maskMethods = new Set(program.flatMap(n => (n.form === 'mask' ? n.methods : [])))
  const { lend, fresh } = listFacts(program, gatedTasks(program, maskMethods))
  const fns = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))
  const plain = new Map(
    program.flatMap(n =>
      n.form === 'record-type' && !n.params.length && !n.variants.length && n.fields.length && !n.shared && !n.alias ? [[n.name, n] as const] : [],
    ),
  )
  const scalar = (t: Type | undefined): boolean => ['number', 'float', 'boolean', 'string'].includes(t?.kind ?? '')
  const isForm = (t: Type | undefined): string | undefined => (t?.kind === 'named' && plain.has(t.name) && !(t.args ?? []).length ? t.name : undefined)

  // 0. the forms a second name can hold a value of, anywhere: a `let` given anything but a `make` (a slot read, a call
  // that may answer one), a walk's item over a list of it, a closure's parameter. `privateForms` admits a local read
  // from a slot, which a place write then checks; a reuse changes the object under every such name, so none may exist
  const aliased = new Set<string>()
  const scan = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return
    if (Array.isArray(value)) return value.forEach(scan)

    const node = value as Loose

    if (node.form === 'let') {
      const form = isForm((node.type ?? (node.init as Loose).type) as Type | undefined)

      if (form && (node.init as Loose).form !== 'record') aliased.add(form)
    }

    if (node.form === 'for-each') {
      const iterable = (node.iterable as Loose).type as Type | undefined
      const form = iterable?.kind === 'array' ? isForm(iterable.element) : undefined

      if (form) aliased.add(form)
    }

    if (node.form === 'closure') {
      for (const p of node.params as { type?: Type }[]) {
        const form = isForm(p.type)

        if (form) aliased.add(form)
      }
    }

    Object.entries(node).forEach(([k, child]) => k !== 'type' && k !== 'span' && scan(child))
  }

  scan(program)

  // 1. the eligible tasks
  const eligible = new Map<string, { param: number; form: string; carrier?: { form: string; field: string }; builds: Loose[]; returns: Loose[] }>()

  for (const fn of fns.values()) {
    if (fn.async || fn.generics?.length) {
      continue
    }

    const records = fn.params.flatMap((p, i) => (isForm(p.type) ? [i] : []))

    if (records.length !== 1 || !fn.params.every((p, i) => i === records[0] || scalar(p.type))) {
      continue
    }

    const param = records[0]!
    const form = isForm(fn.params[param]!.type)!

    if (aliased.has(form)) {
      continue
    }
    const name = fn.params[param]!.name
    let ok = true
    const returns: Loose[] = []
    const walk = (value: unknown, parent: Loose | undefined, key: string): void => {
      if (!ok || typeof value !== 'object' || value === null) return
      if (Array.isArray(value)) return value.forEach(v => walk(v, parent, key))

      const node = value as Loose

      if (node.form === 'closure' || node.form === 'await') {
        ok = false

        return
      }

      // the parameter read only by field, and never rebound
      if (node.form === 'variable' && node.name === name && !(parent?.form === 'member' && key === 'target' && parent.index === undefined)) {
        ok = false
      }

      if ((node.form === 'let' && node.name === name) || (node.form === 'assign' && (node.target as Loose).form === 'variable' && (node.target as Loose).name === name)) {
        ok = false
      }

      if (node.form === 'return') {
        returns.push((node.value as Loose | undefined) ?? {})
      }

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span') walk(child, node, k)
      }
    }

    walk(fn.body, undefined, 'body')

    if (!ok || !returns.length) {
      continue
    }

    // every return a `make F`, or every one a `make G` of one carrier with one field a `make F`
    const direct = returns.every(r => r.form === 'record' && r.name === form)
    const carrierOf = (r: Loose): { form: string; field: string; build: Loose } | undefined => {
      const g = r.form === 'record' ? plain.get(r.name as string) : undefined

      if (!g || g.name === form) return undefined

      const fields = g.fields.filter(f => isForm(f.type) === form)

      if (fields.length !== 1 || !g.fields.every(f => f === fields[0] || scalar(f.type))) return undefined

      const value = (r.fields as { name: string; value: Loose }[]).find(f => f.name === fields[0]!.name)?.value

      return value?.form === 'record' && value.name === form ? { form: g.name, field: fields[0]!.name, build: value } : undefined
    }
    const carried = direct ? [] : returns.map(carrierOf)
    // a build names every field: one left to its default would keep the old object's value in place of the default
    const whole = (r: Loose | undefined): boolean => (r?.fields as unknown[] | undefined)?.length === plain.get(form)!.fields.length

    if (direct ? !returns.every(whole) : !carried.every(c => c && whole(c.build))) {
      continue
    }

    if (direct) {
      eligible.set(fn.name, { param, form, builds: returns, returns })
    } else if (carried.every(c => c && c.form === carried[0]!.form && c.field === carried[0]!.field)) {
      eligible.set(fn.name, { param, form, carrier: { form: carried[0]!.form, field: carried[0]!.field }, builds: carried.map(c => c!.build), returns })
    }
  }

  // 2. the sites: `xs/{i}` passed at the parameter and written with the result at once
  const sameSlot = (a: Loose | undefined, b: Loose | undefined): boolean => {
    const x = slotRead(fns, a)
    const y = slotRead(fns, b)

    return (
      a?.form === 'member' &&
      b?.form === 'member' &&
      x !== undefined &&
      y !== undefined &&
      x.list === y.list &&
      x.index !== undefined &&
      JSON.stringify(x.index) === JSON.stringify(y.index)
    )
  }
  const candidates: { call: Loose; task: string; arg: Loose; carried?: Loose; local?: string; let?: Loose; write?: Loose; fn: Fn }[] = []

  for (const fn of fns.values()) {
    const lists = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) return

      if (Array.isArray(value)) {
        const block = value as Loose[]

        block.forEach((s, k) => {
          // `save xs/{i}, call t(.., xs/{i}, ..)`
          if (s?.form === 'assign' && s.op === '=' && (s.value as Loose)?.form === 'call') {
            const call = s.value as Loose
            const task = (call.callee as Loose).form === 'variable' ? eligible.get((call.callee as Loose).name as string) : undefined
            const arg = task ? (call.args as Loose[])[task.param] : undefined

            if (task && !task.carrier && sameSlot(arg, s.target as Loose)) {
              candidates.push({ call, task: (call.callee as Loose).name as string, arg: arg!, fn })
            }
          }

          // `host m, call t(.., xs/{i}, ..)` and then `save xs/{i}, read m/<the carried field>`
          const next = block[k + 1]

          if (s?.form === 'let' && (s.init as Loose)?.form === 'call' && next?.form === 'assign' && next.op === '=') {
            const call = s.init as Loose
            const task = (call.callee as Loose).form === 'variable' ? eligible.get((call.callee as Loose).name as string) : undefined
            const arg = task ? (call.args as Loose[])[task.param] : undefined
            const value = next.value as Loose

            if (
              task?.carrier &&
              sameSlot(arg, next.target as Loose) &&
              value.form === 'member' &&
              value.index === undefined &&
              value.name === task.carrier.field &&
              (value.target as Loose).form === 'variable' &&
              (value.target as Loose).name === s.name
            ) {
              candidates.push({ call, task: (call.callee as Loose).name as string, arg: arg!, carried: value, local: s.name as string, let: s, write: next, fn })
            }
          }
        })
      }

      Object.entries(value as object).forEach(([k, child]) => k !== 'type' && k !== 'span' && lists(child))
    }

    lists(fn.body)
  }

  // the carrier local read afterwards only for its other fields, and never rebound or passed
  const sites = candidates.filter(c => {
    if (!c.local) return true

    let ok = true
    let lets = 0
    const field = eligible.get(c.task)!.carrier!.field
    const check = (value: unknown, parent: Loose | undefined, key: string): void => {
      if (!ok || typeof value !== 'object' || value === null) return
      if (Array.isArray(value)) return value.forEach(v => check(v, parent, key))

      const node = value as Loose

      if (node.form === 'let' && node.name === c.local) lets++
      if (node.form === 'assign' && (node.target as Loose).form === 'variable' && (node.target as Loose).name === c.local) ok = false

      if (node.form === 'variable' && node.name === c.local) {
        const read = parent?.form === 'member' && key === 'target' && parent.index === undefined

        if (!read || (parent!.name === field && parent !== c.carried)) ok = false
      }

      for (const [k, child] of Object.entries(node)) {
        if (k !== 'type' && k !== 'span') check(child, node, k)
      }
    }

    check(c.fn.body, undefined, 'body')

    return ok && lets === 1
  })

  // 3. still slot-private with those places allowed
  const nodes = new WeakSet<object>()
  const carriers = new Set<string>()

  for (const site of sites) {
    const task = eligible.get(site.task)!

    nodes.add(site.arg)

    if (site.carried) nodes.add(site.carried)

    if (task.carrier) carriers.add(task.carrier.form)

    for (const build of task.builds) nodes.add(build)
  }

  const kept = privateForms(program, lend, fresh, undefined, { nodes, carriers })
  const out: Reuse = { tasks: new Map(), sites: new WeakSet(), forms: new Set(), locals: new WeakMap(), writeBacks: new WeakSet() }

  for (const site of sites) {
    const task = eligible.get(site.task)!

    if (!kept.has(task.form) || (task.carrier && !kept.has(task.carrier.form))) {
      continue
    }

    out.sites.add(site.call)
    out.forms.add(task.form)

    // a carrier of two fields: the copy answers the other one alone
    const carrier = task.carrier ? plain.get(task.carrier.form) : undefined
    const other = carrier && carrier.fields.length === 2 ? carrier.fields.find(f => f.name !== task.carrier!.field) : undefined

    if (!out.tasks.has(site.task)) {
      out.tasks.set(site.task, {
        param: task.param,
        form: task.form,
        builds: new WeakSet(task.builds),
        ...(other ? { keep: { field: other.name, type: other.type as Type }, carriers: new WeakSet(task.returns) } : {}),
      })
    }

    if (other && site.let && site.write) {
      out.locals.set(site.let, other.name)
      out.writeBacks.add(site.write)
    }
  }

  return out
}

// a slot local read through its slot: the list and the index it was read at
export type SlotLocal = { list: Expression; index: Expression }

// the list and index expressions of a slot read: `xs/{i}`, `xs/0`, `get(xs, i)`, `xs.at(i)`
function slotParts(fns: Map<string, Fn>, node: Loose): SlotLocal | undefined {
  if (!slotRead(fns, node)) {
    return undefined
  }

  if (node.form === 'member') {
    const index = (node.index as Expression | undefined) ?? ({ form: 'integer', value: Number(node.name), span: node.span, type: { kind: 'number' } } as Expression)

    return { list: node.target as Expression, index }
  }

  const callee = node.callee as Loose
  const args = node.args as Expression[]

  return callee.form === 'member' ? { list: callee.target as Expression, index: args[0]! } : { list: args[0]!, index: args[1]! }
}

// the slot writes made in place (fact 2), for the forms `privateForms` answers. With `locals`, also the SLOT LOCALS
// (Swift, where a record is a value and holding one copies it): a `let` read from a slot whose every later use is a
// field read that the slot itself answers the same, because nothing between can change that slot but a write made in
// place through the local, after which the local reads only unchanged fields. Read through the slot, no copy is made
// (n-body on Swift: 202 ms to 161, the hand version 155, `tmp/swift-nbody-variants.ts`)
export function placeWrites(
  program: Program,
  forms: Set<string>,
  locals?: Map<Statement, SlotLocal>,
): Map<Statement, PlaceWrite> {
  const writes = new Map<Statement, PlaceWrite>()

  if (!forms.size) {
    return writes
  }

  const fns = new Map(program.flatMap(n => (n.form === 'function' ? [[n.name, n] as const] : [])))
  const fieldsOf = new Map(
    program.flatMap(n => (n.form === 'record-type' && forms.has(n.name) ? [[n.name, n.fields.map(f => f.name)] as const] : [])),
  )

  for (const fn of fns.values()) {
    // every `let` of the function, its block and its place in it, so an index can be traced to how it was made
    const lets = new Map<string, { block: Statement[]; at: number; init: Loose }[]>()
    // every assignment to a variable, by name
    const assigns = new Map<string, Loose[]>()

    const index = (value: unknown): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        value.forEach((s, at) => {
          const node = s as Loose

          if (node?.form === 'let') {
            const all = lets.get(node.name as string) ?? []
            all.push({ block: value as Statement[], at, init: node.init as Loose })
            lets.set(node.name as string, all)
          }

          index(s)
        })

        return
      }

      const node = value as Loose

      if (node.form === 'assign' && (node.target as Loose).form === 'variable') {
        const name = (node.target as Loose).name as string
        const all = assigns.get(name) ?? []
        all.push(node)
        assigns.set(name, all)
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          index(child)
        }
      }
    }

    index(fn.body)

    // `hi` made once as `lo + c` (c at least 1) and only ever counted up, inside the statements from its `let` to its
    // last mention, where `lo` is never written: there `hi` is above `lo`. Answers that range's nodes
    const above = (hi: string, lo: string): Set<object> | undefined => {
      const made = lets.get(hi)

      if (made?.length !== 1) {
        return undefined
      }

      const { block, at, init } = made[0]!
      const plus =
        init.form === 'binary' &&
        init.op === '+' &&
        (((init.left as Loose).form === 'variable' &&
          (init.left as Loose).name === lo &&
          (init.right as Loose).form === 'integer' &&
          ((init.right as Loose).value as number) >= 1) ||
          ((init.right as Loose).form === 'variable' &&
            (init.right as Loose).name === lo &&
            (init.left as Loose).form === 'integer' &&
            ((init.left as Loose).value as number) >= 1))
      const counted = (assigns.get(hi) ?? []).every(a => {
        const v = a.value as Loose
        const step = (x: Loose, y: Loose): boolean =>
          x.form === 'variable' && x.name === hi && y.form === 'integer' && (y.value as number) >= 0

        return a.op === '=' && v.form === 'binary' && v.op === '+' && (step(v.left as Loose, v.right as Loose) || step(v.right as Loose, v.left as Loose))
      })

      if (!plus || !counted) {
        return undefined
      }

      let last = at

      for (let k = at + 1; k < block.length; k++) {
        if (namesIn(block[k]).has(hi)) {
          last = k
        }
      }

      const range = block.slice(at, last + 1)

      if ((assigns.get(lo) ?? []).some(a => within(range, a))) {
        return undefined
      }

      return nodesOf(range)
    }

    // two indices that cannot be one slot where every node of `at` runs
    const distinct = (a: Slot['index'], b: Slot['index'], at: object[]): boolean => {
      if (!a || !b) {
        return false
      }

      if ('value' in a && 'value' in b) {
        return a.value !== b.value
      }

      if (!('name' in a) || !('name' in b) || a.name === b.name) {
        return false
      }

      const range = above(a.name, b.name) ?? above(b.name, a.name)

      return range !== undefined && at.every(n => range.has(n))
    }

    const blocks = (value: unknown, visitBlock: (block: Statement[], ancestors: Statement[][]) => void, ancestors: Statement[][] = []): void => {
      if (typeof value !== 'object' || value === null) {
        return
      }

      if (Array.isArray(value)) {
        if (value.every(s => typeof s === 'object' && s !== null && typeof (s as Loose).form === 'string')) {
          visitBlock(value as Statement[], ancestors)
        }

        value.forEach(s => blocks(s, visitBlock, [...ancestors, value as Statement[]]))

        return
      }

      const node = value as Loose

      if (node.form === 'closure') {
        return
      }

      for (const [key, child] of Object.entries(node)) {
        if (key !== 'type' && key !== 'span') {
          blocks(child, visitBlock, ancestors)
        }
      }
    }

    blocks(fn.body, (block, ancestors) => {
      block.forEach((write, q) => {
        const placed = inPlace(block, q, ancestors)

        if (placed) {
          writes.set(write, placed)
        }
      })
    })

    if (locals) {
      blocks(fn.body, block => {
        block.forEach((s, p) => {
          const local = slotLocal(block, p)

          if (local) {
            locals.set(s, local)
          }
        })
      })
    }

    function slotLocal(block: Statement[], p: number): SlotLocal | undefined {
      const s = block[p] as Loose
      const read = s.form === 'let' ? slotRead(fns, s.init as Loose) : undefined
      const form = s.form === 'let' ? named((s.type ?? (s.init as Loose).type) as Type, forms) : undefined

      if (!read || !read.index || !form || (read.list as string | undefined) === undefined) {
        return undefined
      }

      const b = s.name as string

      if ((lets.get(b)?.length ?? 0) !== 1 || assigns.has(b)) {
        return undefined
      }

      // the statements from the read to the local's last mention
      let last = p

      for (let k = p + 1; k < block.length; k++) {
        if (namesIn(block[k]).has(b)) {
          last = k
        }
      }

      const window = block.slice(p + 1, last + 1)
      const every = new Set(fieldsOf.get(form)!)
      const reads = changedReads(window, b, every)

      // every use a field read
      if (reads === undefined) {
        return undefined
      }

      const indexName = 'name' in read.index ? read.index.name : undefined
      let clear = true
      const scan = (value: unknown): void => {
        if (!clear || typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(scan)

          return
        }

        const node = value as Loose

        if (node.form === 'closure') {
          clear = false

          return
        }

        if (node.form === 'assign') {
          const target = node.target as Loose

          if (target.form === 'variable' && (target.name === read.list || target.name === indexName)) {
            clear = false

            return
          }

          // a write to the list: made in place through this local, or at a slot provably another
          const other = slotRead(fns, target)

          if (other && other.list === read.list) {
            const mine = writes.get(node as Statement)?.local === b

            if (!mine && !distinct(other.index, read.index, [node, ...reads])) {
              clear = false

              return
            }
          }
        }

        if (node.form === 'call') {
          const callee = node.callee as Loose
          const passes = (node.args as Loose[]).some(a => a.form === 'variable' && a.name === read.list)
          const onList = callee.form === 'member' && (callee.target as Loose).form === 'variable' && (callee.target as Loose).name === read.list

          if ((passes && !listMethod(fns, callee, ['get', 'at'])) || (onList && !['at', 'get', 'length'].includes(callee.name as string))) {
            clear = false

            return
          }
        }

        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            scan(child)
          }
        }
      }

      scan(window)

      return clear ? slotParts(fns, s.init as Loose) : undefined
    }

    function inPlace(block: Statement[], q: number, ancestors: Statement[][]): PlaceWrite | undefined {
      const w = block[q] as Loose

      if (w.form !== 'assign' || w.op !== '=') {
        return undefined
      }

      const slot = slotRead(fns, w.target as Loose)
      const value = w.value as Loose
      const listType = ((w.target as Loose).target as Loose | undefined)?.type as Type | undefined
      const form = elementOf(listType, forms)

      if (!slot || !slot.index || !form || value.form !== 'record' || value.name !== form || (value.positional as unknown[] | undefined)?.length) {
        return undefined
      }

      const fields = value.fields as { name: string; value: Loose }[]
      const declared = fieldsOf.get(form)!

      if (fields.length !== declared.length || !declared.every(f => fields.some(x => x.name === f))) {
        return undefined
      }

      // the local that holds the slot's object: the nearest earlier `let` in this block read from the same slot
      let p = q - 1

      for (; p >= 0; p--) {
        const s = block[p] as Loose
        const read = s.form === 'let' ? slotRead(fns, s.init as Loose) : undefined

        if (read && read.list === slot.list && sameIndex(read.index, slot.index)) {
          break
        }
      }

      if (p < 0) {
        return undefined
      }

      const b = (block[p] as Loose).name as string
      const changed = fields.filter(f => !(f.value.form === 'member' && f.value.index === undefined && (f.value.target as Loose).form === 'variable' && (f.value.target as Loose).name === b && f.value.name === f.name))
      const changedNames = new Set(changed.map(f => f.name))
      const between = block.slice(p + 1, q)
      const indexName = 'name' in slot.index ? slot.index.name : undefined

      // nothing between may rebind the list, the index or the local, pass the list to anything but a read, change its
      // length, or write a slot that could be this one
      let clear = true
      const scan = (value: unknown): void => {
        if (!clear || typeof value !== 'object' || value === null) {
          return
        }

        if (Array.isArray(value)) {
          value.forEach(scan)

          return
        }

        const node = value as Loose

        if (node.form === 'closure') {
          clear = false

          return
        }

        if (node.form === 'assign') {
          const target = node.target as Loose

          if (target.form === 'variable' && [slot.list, indexName, b].includes(target.name as string)) {
            clear = false

            return
          }

          const other = slotRead(fns, target)

          if (other && other.list === slot.list && !distinct(other.index, slot.index, [node, w])) {
            clear = false

            return
          }
        }

        if (node.form === 'call') {
          const reads = listMethod(fns, node.callee as Loose, ['get', 'at'])
          const passes = (node.args as Loose[]).some(a => a.form === 'variable' && a.name === slot.list)
          const callee = node.callee as Loose
          const onList = callee.form === 'member' && (callee.target as Loose).form === 'variable' && (callee.target as Loose).name === slot.list

          if ((passes && !reads) || (onList && callee.name !== 'at' && callee.name !== 'get' && callee.name !== 'length')) {
            clear = false

            return
          }
        }

        for (const [key, child] of Object.entries(node)) {
          if (key !== 'type' && key !== 'span') {
            scan(child)
          }
        }
      }

      scan(between)

      if (!clear) {
        return undefined
      }

      // after the write, `b` is read only for an unchanged field
      const after = block.slice(q + 1)

      if (!readsOnly(after, b, changedNames)) {
        return undefined
      }

      // every other local that may hold an element of this list, live across the write
      for (let k = 0; k < q; k++) {
        const s = block[k] as Loose

        if (s.form !== 'let' || k === p || !named(s.type as Type ?? (s.init as Loose).type as Type, forms)) {
          continue
        }

        const x = s.name as string
        const read = slotRead(fns, s.init as Loose)

        // made fresh here, or read from another list: nothing it holds is in this slot
        if (s.init && ((s.init as Loose).form === 'record' || (read && read.list !== slot.list))) {
          continue
        }

        const reads = changedReads(after, x, changedNames)

        if (reads === undefined) {
          return undefined
        }

        if (!reads.length) {
          continue
        }

        // its index must be a different one wherever both run, and stay that one from its `let` to its last read
        if (!read || !distinct(read.index, slot.index, [w, ...reads])) {
          return undefined
        }

        const xIndex = read.index && 'name' in read.index ? read.index.name : undefined
        const window = block.slice(k + 1)

        if (xIndex && (assigns.get(xIndex) ?? []).some(a => within(window, a) && before(block, a, reads))) {
          return undefined
        }

        if (indexName && (assigns.get(indexName) ?? []).some(a => within(window, a) && before(block, a, reads))) {
          return undefined
        }
      }

      // a local of an enclosing block, or a walk's item, that holds an element: refused if it reads a changed field at
      // all, since a loop around the write runs its reads again after it
      for (const outer of ancestors) {
        for (const s of outer) {
          const node = s as Loose

          if (node.form === 'let' && named((node.type ?? (node.init as Loose).type) as Type, forms) && (node.init as Loose).form !== 'record') {
            const reads = changedReads(outer, node.name as string, changedNames)

            if (reads === undefined || reads.length) {
              return undefined
            }
          }

          if (node.form === 'for-each' && elementOf((node.iterable as Loose).type as Type, forms) && within([s], w)) {
            const reads = changedReads(node.body, node.item as string, changedNames)

            if (reads === undefined || reads.length) {
              return undefined
            }
          }
        }
      }

      // the values are computed first when one reads a field an earlier assignment of this write changes, or calls
      // anything that could read the slot
      const assigned = new Set<string>()
      let temps = false

      for (const f of changed) {
        if (!simple(f.value) || [...assigned].some(name => readsField(f.value, b, name))) {
          temps = true
        }

        assigned.add(f.name)
      }

      return { local: b, fields: changed.map(f => ({ name: f.name, value: f.value as unknown as Expression })), temps }
    }
  }

  return writes
}

const sameIndex = (a: Slot['index'], b: Slot['index']): boolean =>
  a !== undefined && b !== undefined && (('name' in a && 'name' in b && a.name === b.name) || ('value' in a && 'value' in b && a.value === b.value))

// every variable name a node mentions
function namesIn(value: unknown, into = new Set<string>()): Set<string> {
  if (typeof value !== 'object' || value === null) {
    return into
  }

  if (Array.isArray(value)) {
    value.forEach(v => namesIn(v, into))

    return into
  }

  const node = value as Loose

  if (node.form === 'variable') {
    into.add(node.name as string)
  }

  if (node.form === 'let') {
    into.add(node.name as string)
  }

  for (const [key, child] of Object.entries(node)) {
    if (key !== 'type' && key !== 'span') {
      namesIn(child, into)
    }
  }

  return into
}

function nodesOf(value: unknown, into = new Set<object>()): Set<object> {
  if (typeof value !== 'object' || value === null) {
    return into
  }

  into.add(value)

  if (Array.isArray(value)) {
    value.forEach(v => nodesOf(v, into))

    return into
  }

  for (const [key, child] of Object.entries(value as Loose)) {
    if (key !== 'type' && key !== 'span') {
      nodesOf(child, into)
    }
  }

  return into
}

const within = (range: unknown, node: object): boolean => nodesOf(range).has(node)

// whether an assignment runs in the block before any of the reads: at a statement no later than the last of theirs
function before(block: Statement[], a: object, reads: object[]): boolean {
  const at = block.findIndex(s => within(s, a))
  const last = Math.max(...reads.map(r => block.findIndex(s => within(s, r))))

  return at >= 0 && at <= last
}

// the reads of a changed field of `name` in these statements, or undefined when `name` is used other than by a field
// read there (passed, returned, compared whole), which could see a changed field too
function changedReads(value: unknown, name: string, changed: Set<string>): object[] | undefined {
  const found: object[] = []
  let other = false

  const visit = (v: unknown, parent: Loose | undefined, key: string): void => {
    if (other || typeof v !== 'object' || v === null) {
      return
    }

    if (Array.isArray(v)) {
      v.forEach(x => visit(x, parent, key))

      return
    }

    const node = v as Loose

    if (node.form === 'variable' && node.name === name) {
      if (parent?.form === 'member' && key === 'target' && parent.index === undefined) {
        if (changed.has(parent.name as string)) {
          found.push(parent)
        }
      } else {
        other = true
      }

      return
    }

    for (const [k, child] of Object.entries(node)) {
      if (k !== 'type' && k !== 'span') {
        visit(child, node, k)
      }
    }
  }

  visit(value, undefined, '')

  return other ? undefined : found
}

const readsOnly = (value: unknown, name: string, changed: Set<string>): boolean => {
  const reads = changedReads(value, name, changed)

  return reads !== undefined && reads.length === 0
}

function readsField(value: unknown, name: string, field: string): boolean {
  return changedReads(value, name, new Set([field]))?.length !== 0
}

// a value that reads only locals, fields and literals, through operators and native calls: computing it cannot reach
// the slot
function simple(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return true
  }

  if (Array.isArray(value)) {
    return value.every(simple)
  }

  const node = value as Loose

  switch (node.form) {
    case 'variable':
    case 'integer':
    case 'float':
    case 'string':
    case 'boolean':
      return true
    case 'binary':
      return simple(node.left) && simple(node.right)
    case 'unary':
      return simple(node.operand)
    case 'member':
      return node.index === undefined && simple(node.target)
    case 'call': {
      const callee = node.callee as Loose
      const module = callee.form === 'member' ? (callee.target as Loose) : undefined

      return module?.form === 'variable' && (module.binding as { kind?: string } | undefined)?.kind === 'deferred' && simple(node.args)
    }
    default:
      return false
  }
}
