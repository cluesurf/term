// Every type a task or form names is a type the program has.
//
// The seeding pass reads a name it does not know as a hole, "infer it from usage rather than forcing a mismatch"
// (check/type-seed.ts), so `take x, like widgett` built with no message and `x` took the type of its first call
// (guides: types, types/annotations, types/inference, 2026-10-03). A misspelled type was a missing type, in silence.
//
// The seeder cannot report, since it has no span. This pass reads the declared types where they are written (each
// task's parameters and result, each form's fields) and refuses a named type that is none of: a form, a mask, an
// opaque `dock type`, a name the language gives (`list`, `hash`, `unknown`, `type`), or a type parameter its task
// or form declares. It reads only the file being compiled, so a dependency is held to it where it is compiled itself.

import type { Program, Statement, Type } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

// the names the seeder reads specially, and the language's own: the same list as `PRIMITIVE_TYPE_NAMES` in
// check/infer.ts, whose warning this refusal hardens. A type argument (`like hash, like text, like number`) stays a
// `named` type where a parameter's own `like text` is already the primitive, so the primitives must be here too
const GIVEN = new Set([
  'u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128', 'integer', 'number', 'decimal', 'float', 'f32', 'f64',
  'dynamic', 'json', 'bytes', 'buffer', 'text', 'boolean', 'void', 'unknown', 'any', 'unit', 'list', 'hash', 'task',
  'string', 'natural', 'self', 'type', 'size',
])

function namedIn(type: Type | undefined, out: string[]): void {
  if (!type) {
    return
  }

  switch (type.kind) {
    case 'named':
      out.push(type.name)

      for (const arg of type.args ?? []) {
        namedIn(arg, out)
      }

      break
    case 'array':
      namedIn(type.element, out)
      break
    case 'map':
      namedIn(type.key, out)
      namedIn(type.value, out)
      break
    case 'function':
      for (const param of type.params) {
        namedIn(param, out)
      }

      namedIn(type.result, out)
      break
    default:
      break
  }
}

export function checkTypeNames(program: Program, file: string): Diagnostic[] {
  const known = new Set<string>(GIVEN)

  for (const s of program) {
    if (s.form === 'record-type' || s.form === 'mask') {
      known.add(s.name)
    }

    if (s.form === 'record-type') {
      for (const variant of s.variants) {
        known.add(variant.name)
      }
    }

    // a task to `type` is a type family, and `like pos / head / read s` names it (test/check/container.ts)
    if (s.form === 'function') {
      const result = s.declared?.result ?? s.result

      if (result?.kind === 'named' && result.name === 'type') {
        known.add(s.name)
      }
    }

    // an opaque handle type (`dock type / load <Native>, name x`), and any other native declaration that names one
    if (s.form === 'native') {
      const alias = (s as { alias?: string }).alias

      if (alias) {
        known.add(alias)
      }
    }
  }

  const out: Diagnostic[] = []
  const seen = new Set<string>()

  const refuse = (name: string, span: Span, where: string): void => {
    const key = `${span.start.line}:${span.start.column}:${name}`

    if (seen.has(key)) {
      return
    }

    seen.add(key)
    out.push(
      diagnose('unknown-name', {
        file,
        span,
        message: `the type "${name}" is not defined (${where}). A misspelled type used to be read as no type at all`,
        hint: 'name a form, a mask, or a type parameter the task or form declares with `head`',
      }),
    )
  }

  const check = (types: (Type | undefined)[], generics: Set<string>, span: Span, where: string): void => {
    for (const type of types) {
      const names: string[] = []
      namedIn(type, names)

      for (const name of names) {
        if (!known.has(name) && !generics.has(name)) {
          refuse(name, span, where)
        }
      }
    }
  }

  const forms = new Map<string, Extract<Statement, { form: 'record-type' }>>()

  for (const s of program) {
    if (s.form === 'record-type') {
      forms.set(s.name, s)
    }
  }

  for (const s of program) {
    if (s.span.file !== file) {
      continue
    }

    if (s.form === 'function' && !s.stub) {
      // a method sees its form's type parameters as well as its own
      const owner = s.method ? forms.get(s.method.form) : undefined
      const declared = s.declared ?? { params: s.params.map(p => p.type), result: s.result }
      // and a TYPE FAMILY is a parameter that is a task to `type`, used as a type (`take p / like task / ... / like
      // type`, then `like p / head / read x`): the proof library's substitution and its convoy are built on one
      const families = s.params.filter((p, i) => {
        const type = declared.params[i] ?? p.type

        return type?.kind === 'function' && type.result.kind === 'named' && type.result.name === 'type'
      })
      const generics = new Set([
        ...s.generics.map(g => g.name),
        ...(owner?.params ?? []),
        ...families.map(p => p.name),
      ])
      const where = `in \`${s.method?.name ?? s.name}\``

      // each parameter at its own `take` line, the result at the task
      declared.params.forEach((type, i) => check([type], generics, s.params[i]?.span ?? s.span, where))
      check([declared.result], generics, s.span, where)
    }

    if (s.form === 'record-type') {
      const written = [...s.fields, ...s.variants.flatMap(v => v.fields)]
      const fields = written.map(f => f.type)

      // each field at its own `link` line
      for (const field of written) {
        check([field.type], new Set(s.params), field.span ?? s.span, `in the form \`${s.name}\``)
      }

      // a generic form that names ITSELF without its parameter: `link rest, like chain` in `form chain / head t`
      // built, and each native backend filled the missing argument its own way, `i64` on Rust and `Any` on Swift and
      // Kotlin, so the rest of a chain of text held numbers on Rust (guides: types/annotations, 2026-10-04)
      if (s.params.length > 0 && fields.some(type => bareSelf(type, s.name))) {
        out.push(
          diagnose('type-mismatch', {
            file,
            span: s.span,
            message: `the form \`${s.name}\` names itself without its ${s.params.length === 1 ? 'parameter' : 'parameters'}: write \`like ${s.name} ${s.params.join(' ')}\``,
            hint: `a generic form passes its own ${s.params.length === 1 ? 'parameter' : 'parameters'} on where it names itself, or each backend fills the gap differently`,
          }),
        )
      }
    }
  }

  // a CONSTRUCTION is held to the same rule: `make unit` (no such form) built a `{}` on TypeScript wherever the slot was
  // `like unknown`, and only the native compilers refused it, as `Unit {}` naming nothing (the compile/memo port,
  // 2026-10-04). A construction names a form, a case of one (`make red`, or `make light/red`), or the native empty
  // `make hash` / `make list`. `make list(1, 2)` and its kin are the native collections too. `make void` is the
  // language's empty value: `@term/base/void` declares the form, and the program carries it as the primitive
  const constructible = new Set<string>(['hash', 'list', 'void'])

  for (const s of program) {
    if (s.form === 'record-type') {
      constructible.add(s.name)

      for (const variant of s.variants) {
        constructible.add(variant.name)
        constructible.add(`${s.name}/${variant.name}`)
      }
    }
  }

  for (const s of program) {
    if (s.span.file !== file || s.form !== 'function' || s.stub) {
      continue
    }

    eachConstruction(s.body, node => {
      if (!constructible.has(node.name)) {
        out.push(
          diagnose('unknown-name', {
            file,
            span: node.span ?? s.span,
            message: `\`make ${node.name}\` names no form (in \`${s.method?.name ?? s.name}\`). It built an empty record on TypeScript and nothing on a native backend`,
            hint: 'name a form or one of its cases, or `make hash` / `make list`',
          }),
        )
      }
    })
  }

  return out
}

// every `record` construction under a value, found structurally: any object carrying a `form`, through every field,
// so a new expression form cannot hide one
function eachConstruction(value: unknown, visit: (node: { name: string; span?: Span }) => void, seen = new Set<object>()): void {
  if (value === null || typeof value !== 'object' || seen.has(value)) {
    return
  }

  seen.add(value)

  if (Array.isArray(value)) {
    for (const item of value) {
      eachConstruction(item, visit, seen)
    }

    return
  }

  const node = value as { form?: unknown; name?: unknown; span?: Span; type?: unknown }

  if (node.form === 'record' && typeof node.name === 'string') {
    visit(node as { name: string; span?: Span })
  }

  for (const [key, field] of Object.entries(value)) {
    // a type and a span hold no construction
    if (key !== 'type' && key !== 'span' && key !== 'declared') {
      eachConstruction(field, visit, seen)
    }
  }
}

// does a type name the form `name` anywhere without type arguments
function bareSelf(type: Type | undefined, name: string): boolean {
  if (!type) {
    return false
  }

  switch (type.kind) {
    case 'named':
      return (type.name === name && (type.args?.length ?? 0) === 0) || (type.args ?? []).some(arg => bareSelf(arg, name))
    case 'array':
      return bareSelf(type.element, name)
    case 'map':
      return bareSelf(type.key, name) || bareSelf(type.value, name)
    case 'function':
      return type.params.some(param => bareSelf(param, name)) || bareSelf(type.result, name)
    default:
      return false
  }
}
