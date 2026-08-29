// Form extension: `form x` that is `like <base>` with children extends the base. This pass resolves every such form
// into an ordinary record before resolution, so the resolver, the checker and every backend see plain fields:
//
//   - `head <param>, like <t>` and `head <param>` over `link` lines supply the base's type arguments by name
//   - `link` lines directly under the `like` add props to the base's single record parameter (the short form), or
//     extend the record a previous extension already fixed it to
//   - `bind <field>, <value>` pins a field: every instance carries that value, and a construction that gives it is
//     refused
//
// It also finishes a raise. `halt <form>` mills to a `throw` of the record as written plus `raise: <form>`; here the
// form is checked to descend from `exception`, the props are checked against the props record (a missing required
// prop, an unknown one, or a pinned one is a diagnostic), fallbacks are filled, and the fields the runtime owns
// (`host`, `form`, `code`, `time`) are added. See note/term/hive/03-exception.md. Pure over the program.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'

type RecordType = Extract<Statement, { form: 'record-type' }>
type Field = RecordType['fields'][number]

// the root every exception descends from, and the stdlib tasks a raise calls for its occurrence code and time
export const EXCEPTION_FORM = 'exception'
const OCCURRENCE_TASK = 'exception-code'
const TIME_TASK = 'exception-time'

// the fields of `exception` the runtime fills. A raise never writes them and a declaration never pins them.
const OWNED = new Set(['host', 'form', 'code', 'time'])

export type ExtendOptions = {
  // the deck a source file belongs to, for the `host` of a raise. Absent means it is guessed from the file path
  // (`.../link/@scope/name/...`), and `@local` when it cannot be.
  deckOf?: (file: string) => { name: string; root: string } | undefined
}

export function extendForms(
  program: Program,
  file: string,
  origin?: WeakMap<Statement, string>,
  options?: ExtendOptions,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const fileOf = (s: Statement): string => origin?.get(s) ?? file

  const types = new Map<string, RecordType>()

  for (const s of program) {
    if (s.form === 'record-type') {
      types.set(s.name, s)
    }
  }

  // the records this pass synthesizes for anonymous props (`upload-excess-link`), appended to the program
  const synthesized: RecordType[] = []
  const resolved = new Set<string>()
  const resolving = new Set<string>()

  const error = (s: Statement, span: Span, message: string): void => {
    diagnostics.push(
      diagnose('type-mismatch', { file: fileOf(s), span, message }),
    )
  }

  // substitute a base's type parameters in a field type
  const subst = (type: Type, map: Map<string, Type>): Type => {
    switch (type.kind) {
      case 'named': {
        const hit = map.get(type.name)

        if (hit && !type.args?.length) {
          return hit
        }

        return type.args
          ? { ...type, args: type.args.map(a => subst(a, map)) }
          : type
      }
      case 'array':
        return { kind: 'array', element: subst(type.element, map) }
      case 'map':
        return {
          kind: 'map',
          key: subst(type.key, map),
          value: subst(type.value, map),
        }
      case 'function':
        return {
          ...type,
          params: type.params.map(p => subst(p, map)),
          result: subst(type.result, map),
        }
      default:
        return type
    }
  }

  const cloneField = (f: Field, type: Type): Field => ({ ...f, type })

  const resolveOne = (rt: RecordType): void => {
    if (resolved.has(rt.name) || !rt.extend) {
      return
    }

    if (resolving.has(rt.name)) {
      error(rt, rt.extend.span, `"${rt.name}" extends itself`)
      resolved.add(rt.name)

      return
    }

    resolving.add(rt.name)

    const ext = rt.extend
    const baseType = ext.base

    if (baseType.kind !== 'named' || !types.has(baseType.name)) {
      error(
        rt,
        ext.span,
        `"${rt.name}" is like "${
          baseType.kind === 'named' ? baseType.name : 'a non-form type'
        }", which is not a form that can be extended`,
      )
      resolving.delete(rt.name)
      resolved.add(rt.name)

      return
    }

    const base = types.get(baseType.name)!
    resolveOne(base)

    // the base's type parameters, and how each is supplied
    const map = new Map<string, Type>()
    const baseParams = base.params

    baseType.args?.forEach((arg, i) => {
      const param = baseParams[i]

      if (param) {
        map.set(param, arg)
      }
    })

    // a synthesized props record: `<form>-<field>` where `field` is the base field typed by the parameter, else
    // `<form>-<param>`
    const propsName = (param: string): string => {
      const owner = base.fields.find(
        f => f.type.kind === 'named' && f.type.name === param,
      )

      return `${rt.name}-${owner ? owner.name : param}`
    }

    const synth = (name: string, fields: Field[], span: Span): void => {
      const record: RecordType = {
        form: 'record-type',
        name,
        params: [],
        fields,
        variants: [],
        functionFree: fields.every(f => f.type.kind !== 'function'),
        span,
      }

      synthesized.push(record)
      types.set(name, record)
      resolved.add(name)
      origin?.set(record, fileOf(rt))
    }

    let props: string | undefined = base.props

    for (const head of ext.heads) {
      if (!baseParams.includes(head.name)) {
        error(
          rt,
          head.span,
          `"${base.name}" has no type parameter "${head.name}"${
            baseParams.length ? ` (it has ${baseParams.join(', ')})` : ''
          }`,
        )
        continue
      }

      if (head.links) {
        const name = propsName(head.name)
        synth(name, head.links, head.span)
        map.set(head.name, { kind: 'named', name })
        props = name
      } else if (head.type) {
        map.set(head.name, head.type)
      }
    }

    // the short form: `link` lines directly under the `like` fill the base's one record parameter, or extend the
    // record a previous extension fixed it to
    if (ext.links.length > 0) {
      const open = baseParams.filter(p => !map.has(p))

      if (open.length === 1) {
        const name = propsName(open[0]!)
        synth(name, ext.links, ext.span)
        map.set(open[0]!, { kind: 'named', name })
        props = name
      } else if (open.length === 0 && base.props && types.has(base.props)) {
        const inherited = types.get(base.props)!
        const name = `${rt.name}-${base.props.slice(base.name.length + 1)}`
        const merged = [...inherited.fields]

        for (const link of ext.links) {
          const at = merged.findIndex(f => f.name === link.name)

          if (at >= 0) {
            merged[at] = link
          } else {
            merged.push(link)
          }
        }

        synth(name, merged, ext.span)
        map.set(`__props__${base.props}`, { kind: 'named', name })
        props = name
      } else if (open.length > 1) {
        error(
          rt,
          ext.span,
          `"${base.name}" takes ${open.length} type parameters (${open.join(
            ', ',
          )}), so a \`link\` under \`like\` must sit under a \`head <name>\` that says which one it fills`,
        )
      } else {
        error(
          rt,
          ext.span,
          `"${base.name}" takes no record parameter, so a \`link\` under \`like ${base.name}\` has nothing to add to`,
        )
      }
    }

    // inherited fields, substituted, then the form's own top-level fields
    const inherited = base.fields.map(f => {
      let type = subst(f.type, map)

      // a field typed by a previously synthesized props record: re-point it at the extended one
      if (
        type.kind === 'named' &&
        base.props &&
        type.name === base.props &&
        map.has(`__props__${base.props}`)
      ) {
        type = map.get(`__props__${base.props}`)!
      }

      return cloneField(f, type)
    })

    const own = rt.fields.filter(f => !inherited.some(i => i.name === f.name))
    rt.fields = [...inherited, ...own]

    // parameters the extension left open stay parameters of this form
    for (const p of baseParams) {
      if (!map.has(p) && !rt.params.includes(p)) {
        rt.params.push(p)
      }
    }

    // pins: inherited first, then this form's, later winning
    const pins = [...(base.pins ?? [])]

    for (const pin of ext.pins) {
      if (OWNED.has(pin.name) && (base.chain ?? [base.name]).concat(base.name).includes(EXCEPTION_FORM)) {
        error(
          rt,
          ext.span,
          `"${pin.name}" is filled by the runtime on every exception and cannot be pinned`,
        )
        continue
      }

      // a pin names a field of the form, or a prop of its props record (`bind thing, <upload>` on an exception)
      const propsFields = props ? types.get(props)?.fields ?? [] : []

      if (
        !rt.fields.some(f => f.name === pin.name) &&
        !propsFields.some(f => f.name === pin.name)
      ) {
        error(
          rt,
          ext.span,
          `"${rt.name}" pins "${pin.name}", which is not a field or prop of "${base.name}"`,
        )
        continue
      }

      const at = pins.findIndex(p => p.name === pin.name)

      if (at >= 0) {
        pins[at] = pin
      } else {
        pins.push(pin)
      }
    }

    rt.pins = pins
    rt.chain = [...(base.chain ?? []), base.name]
    rt.props = props
    rt.functionFree = rt.fields.every(f => f.type.kind !== 'function')

    resolving.delete(rt.name)
    resolved.add(rt.name)
  }

  for (const rt of [...types.values()]) {
    resolveOne(rt)
  }

  program.push(...synthesized)

  // an exception form must pin `note`, directly or by inheritance
  for (const rt of types.values()) {
    if (
      rt.chain?.includes(EXCEPTION_FORM) &&
      !rt.pins?.some(p => p.name === 'note')
    ) {
      error(
        rt,
        rt.extend?.span ?? rt.span,
        `"${rt.name}" is an exception and must pin its note (\`bind note, <...>\` under the \`like\`)`,
      )
    }
  }

  // ---- constructions and raises ----

  const isException = (name: string): boolean =>
    types.get(name)?.chain?.includes(EXCEPTION_FORM) ?? false

  const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

  const hostOf = (s: Statement): string => {
    const f = fileOf(s)
    const known = options?.deckOf?.(f)

    if (known) {
      return known.name
    }

    const linked = /\/link\/(@[^/]+\/[^/]+)\//.exec(f)

    return linked ? linked[1]! : '@local'
  }

  // fill a construction: positional values go to the form's `slot` fields in order, omitted fields take their
  // `fall`, a given pinned field is refused and the pins are added. Only the pins that name a field of the form
  // itself; a pin on a prop lives in the props record and is filled by a raise.
  const fillRecord = (
    s: Statement,
    node: Extract<Expression, { form: 'record' }>,
  ): void => {
    const rt = types.get(node.name)

    if (!rt) {
      return
    }

    if (node.positional?.length) {
      const slots = rt.fields.filter(f => f.positional)

      if (slots.length === 0) {
        error(
          s,
          node.span,
          `"${rt.name}" has no slots, so its fields are given by name (\`bind <field>, <value>\`)`,
        )
      } else if (node.positional.length > slots.length) {
        error(
          s,
          node.span,
          `"${rt.name}" has ${slots.length} slot${slots.length === 1 ? '' : 's'} (${slots
            .map(f => f.name)
            .join(', ')}) and this gives ${node.positional.length} values`,
        )
      } else {
        node.positional.forEach((value, i) => {
          const slot = slots[i]!

          if (node.fields.some(f => f.name === slot.name)) {
            error(s, value.span, `"${slot.name}" is given twice, by position and by name`)
          } else {
            node.fields.push({ name: slot.name, value })
          }
        })
      }

      delete node.positional
    }

    for (const f of rt.fields) {
      if (f.fallback && !node.fields.some(x => x.name === f.name)) {
        node.fields.push({ name: f.name, value: clone(f.fallback) })
      }
    }

    if (!rt.pins?.length) {
      return
    }

    const pins = rt.pins.filter(p => rt.fields.some(f => f.name === p.name))

    for (const field of node.fields) {
      if (pins.some(p => p.name === field.name)) {
        error(
          s,
          field.value.span,
          `"${field.name}" is pinned by "${rt.name}" and cannot be given here`,
        )
      }
    }

    for (const pin of pins) {
      if (!node.fields.some(f => f.name === pin.name)) {
        node.fields.push({ name: pin.name, value: clone(pin.value) })
      }
    }
  }

  // finish a raise: `halt <form>` with its props as written
  const fillRaise = (
    s: Statement,
    node: Extract<Statement, { form: 'throw' }>,
  ): void => {
    const form = node.raise!
    const rt = types.get(form)
    const span = node.span

    if (!rt) {
      error(s, span, `"${form}" is not a form that can be raised`)

      return
    }

    if (!isException(form)) {
      error(
        s,
        span,
        `"${form}" is not an exception. A raised form is \`like exception\` or like one of the stdlib exceptions`,
      )

      return
    }

    if (node.value.form !== 'record') {
      return
    }

    const given = node.value.fields
    const cause = given.find(f => f.name === 'base')
    const props = given.filter(f => f.name !== 'base')
    const propsRecord = rt.props ? types.get(rt.props) : undefined
    const propsFields = propsRecord?.fields ?? []
    const link: { name: string; value: Expression }[] = []

    for (const p of props) {
      if (OWNED.has(p.name) || p.name === 'note') {
        error(
          s,
          p.value.span,
          `"${p.name}" is filled by the runtime or pinned by "${form}" and cannot be given at a raise`,
        )
        continue
      }

      const declared = propsFields.find(f => f.name === p.name)

      if (!declared) {
        error(
          s,
          p.value.span,
          `"${form}" has no prop "${p.name}"${
            propsFields.length
              ? ` (it has ${propsFields.map(f => f.name).join(', ')})`
              : ''
          }`,
        )
        continue
      }

      if (rt.pins?.some(pin => pin.name === p.name)) {
        error(
          s,
          p.value.span,
          `"${p.name}" is pinned by "${form}" and cannot be given at a raise`,
        )
        continue
      }

      link.push(p)
    }

    for (const f of propsFields) {
      if (link.some(l => l.name === f.name)) {
        continue
      }

      const pin = rt.pins?.find(p => p.name === f.name)

      if (pin) {
        link.push({ name: f.name, value: clone(pin.value) })
      } else if (f.fallback) {
        link.push({ name: f.name, value: clone(f.fallback) })
      } else if (!f.optional) {
        error(s, span, `"${form}" needs "${f.name}", which this raise does not give`)
      }
    }

    const text = (value: string): Expression => ({
      form: 'string',
      value,
      span,
    })
    const call = (name: string): Expression => ({
      form: 'call',
      callee: { form: 'variable', name, span },
      args: [],
      span,
    })

    const fields: { name: string; value: Expression }[] = [
      { name: 'host', value: text(hostOf(s)) },
      { name: 'form', value: text(form) },
      { name: 'code', value: call(OCCURRENCE_TASK) },
      { name: 'time', value: call(TIME_TASK) },
    ]

    // the pins of the exception itself (`note`, and anything else pinned on the shared form)
    for (const pin of rt.pins ?? []) {
      if (rt.fields.some(f => f.name === pin.name) && !propsFields.some(f => f.name === pin.name)) {
        fields.push({ name: pin.name, value: clone(pin.value) })
      }
    }

    if (rt.props) {
      fields.push({
        name: 'link',
        value: { form: 'record', name: rt.props, fields: link, span },
      })
    }

    if (cause) {
      fields.push(cause)
    }

    node.value = { form: 'record', name: form, fields, span }
  }

  const walkExpression = (s: Statement, node: Expression): void => {
    switch (node.form) {
      case 'record':
        fillRecord(s, node)
        node.fields.forEach(f => walkExpression(s, f.value))
        break
      case 'call':
        walkExpression(s, node.callee)
        node.args.forEach(a => walkExpression(s, a))
        break
      case 'binary':
        walkExpression(s, node.left)
        walkExpression(s, node.right)
        break
      case 'unary':
        walkExpression(s, node.operand)
        break
      case 'member':
        walkExpression(s, node.target)

        if (node.index) {
          walkExpression(s, node.index)
        }

        break
      case 'await':
        walkExpression(s, node.expr)
        break
      case 'template':
        for (const part of node.parts) {
          if (typeof part !== 'string') {
            walkExpression(s, part)
          }
        }

        break
      case 'array':
        node.items.forEach(i => walkExpression(s, i))
        break
      case 'map':
        node.entries.forEach(e => {
          walkExpression(s, e.key)
          walkExpression(s, e.value)
        })
        break
      case 'closure':
        node.body.forEach(b => walkStatement(s, b))
        break
      case 'conditional':
        node.branches.forEach(b => {
          walkExpression(s, b.cond)
          walkExpression(s, b.value)
        })

        if (node.otherwise) {
          walkExpression(s, node.otherwise)
        }

        break
      default:
        break
    }
  }

  const walkStatement = (s: Statement, node: Statement): void => {
    switch (node.form) {
      case 'let':
        walkExpression(s, node.init)
        break
      case 'assign':
        walkExpression(s, node.target)
        walkExpression(s, node.value)
        break
      case 'expression':
        walkExpression(s, node.expr)
        break
      case 'return':
        if (node.value) {
          walkExpression(s, node.value)
        }

        break
      case 'throw':
        if (node.raise) {
          // the raise builds the record itself (pins included), so only its values are walked
          fillRaise(s, node)

          if (node.value.form === 'record') {
            node.value.fields.forEach(f => {
              if (f.value.form === 'record' && f.name === 'link') {
                f.value.fields.forEach(l => walkExpression(s, l.value))
              } else {
                walkExpression(s, f.value)
              }
            })
          }
        } else {
          walkExpression(s, node.value)
        }

        break
      case 'hold':
        walkExpression(s, node.expr)
        break
      case 'if':
        node.branches.forEach(b => {
          walkExpression(s, b.cond)
          b.body.forEach(x => walkStatement(s, x))
        })
        node.otherwise?.forEach(x => walkStatement(s, x))
        break
      case 'while':
        walkExpression(s, node.cond)
        node.body.forEach(x => walkStatement(s, x))
        break
      case 'for-each':
        walkExpression(s, node.iterable)
        node.body.forEach(x => walkStatement(s, x))
        break
      case 'match':
        walkExpression(s, node.subject)
        node.cases.forEach(c => c.body.forEach(x => walkStatement(s, x)))
        node.otherwise?.forEach(x => walkStatement(s, x))
        break
      case 'function':
        node.body.forEach(x => walkStatement(s, x))
        break
      default:
        break
    }
  }

  for (const s of program) {
    walkStatement(s, s)
  }

  return diagnostics
}

// every exception form in a program, with its chain, for the emitters and the roll
export function exceptionForms(program: Program): Map<string, RecordType> {
  const out = new Map<string, RecordType>()

  for (const s of program) {
    if (s.form === 'record-type' && s.chain?.includes(EXCEPTION_FORM)) {
      out.set(s.name, s)
    }
  }

  return out
}
