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
      check([...declared.params, declared.result], generics, s.span, `in \`${s.method?.name ?? s.name}\``)
    }

    if (s.form === 'record-type') {
      check(
        [...s.fields.map(f => f.type), ...s.variants.flatMap(v => v.fields.map(f => f.type))],
        new Set(s.params),
        s.span,
        `in the form \`${s.name}\``,
      )
    }
  }

  return out
}
