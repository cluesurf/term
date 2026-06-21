// The LLVM backend: emit textual LLVM IR for the native (AOT) target. Functions become `define`s; the scalar
// imperative fragment (immutable + mutable locals, reassignment, `if`, `while`) is lowered the way clang -O0 does it:
// every local gets a stack slot (`alloca`), reads `load` and writes `store`, so mutation and loops need no SSA phi
// nodes (mem2reg recovers SSA). The backend is TYPE-AWARE: numbers and booleans are i64 (comparisons compute as i1
// then zero-extend), and strings are pointers (`ptr`) into a small managed runtime (see compile/llvm-runtime.ts) that
// provides allocation, concatenation, comparison, length, and printing. String literals become module-level
// constants. Remaining aggregates (arrays, maps, records, closures) and exceptions still need runtime support and are
// marked SEED-UNSUPPORTED rather than silently miscompiled. Run monomorphization first (generic functions are dropped
// here). Pure, browser-safe. See note/research/vibe/computation/plans/07-codegen.md.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@cluesurf/make/code/compile/node'
import {
  exhausted,
  unsupported,
  collectionCall,
  collectionRead,
} from '@cluesurf/make/code/compile/backend'
import { monomorphize } from '@cluesurf/make/code/ir/monomorphize'
import { dropSafeHeapLocals } from '@cluesurf/make/code/ir/drop-safe'

function mangle(name: string): string {
  return name.replace(/-/g, '_')
}

const ARITH: Record<string, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'sdiv',
  '%': 'srem',
}

const PRED: Record<string, string> = {
  '==': 'eq',
  '!=': 'ne',
  '<': 'slt',
  '<=': 'sle',
  '>': 'sgt',
  '>=': 'sge',
}

// the floating-point counterparts: `fadd`/.../`fdiv` for arithmetic, ordered `fcmp` predicates for comparison
const FARITH: Record<string, string> = {
  '+': 'fadd',
  '-': 'fsub',
  '*': 'fmul',
  '/': 'fdiv',
  '%': 'frem',
}

const FPRED: Record<string, string> = {
  '==': 'oeq',
  '!=': 'one',
  '<': 'olt',
  '<=': 'ole',
  '>': 'ogt',
  '>=': 'oge',
}

type LlvmType =
  | 'i64'
  | 'double'
  | 'ptr'
  | 'void'
  | '{ ptr, ptr }'
  | '{ i64, i64 }'
  | `%struct.${string}`
// a closure value is a flat pair { code pointer, environment handle }. The environment is a `seed_list` of captured
// words (reusing the list runtime), so a closure needs no new allocator: the captures push into a fresh list.
const CLOSURE_TYPE = '{ ptr, ptr }'
// a sum type (variant / enum, e.g. maybe, result) is a tagged union: { i64 tag, i64 payload }. The tag is the variant's
// declared index; the payload is its single field as a word (a float / pointer reinterpreted at the boundary).
const VARIANT_TYPE = '{ i64, i64 }'
// the field layout of a plain record (product) type, in declared order, for first-class struct lowering
type RecordLayout = { fields: { name: string; type: Type }[] }
// a variant label resolved to its owning sum type, its tag (index), and its single payload field (if any)
type VariantOf = Map<
  string,
  { owner: string; tag: number; field?: { name: string; type: Type } }
>

// the LLVM representation of a checked type: strings are managed pointers, unit is void, floats are double, a plain
// record is a first-class struct value (`%struct.Name`), a sum type is a tagged union, everything else is a 64-bit word
function llty(
  type: Type | undefined,
  records?: Map<string, RecordLayout>,
  variants?: Set<string>,
): LlvmType {
  if (type?.kind === 'string') {return 'ptr'}

  if (type?.kind === 'unit') {return 'void'}

  if (type?.kind === 'float') {return 'double'}

  if (type?.kind === 'array') {return 'ptr'} // a list is an opaque handle to the heap buffer

  if (type?.kind === 'map') {return 'ptr'} // a map is an opaque handle to the heap hash

  if (type?.kind === 'function') {return CLOSURE_TYPE} // a first-class function value: { code, env }

  if (type?.kind === 'named' && variants?.has(type.name))
    {return VARIANT_TYPE}

  if (type?.kind === 'named' && records?.has(type.name))
    {return `%struct.${mangle(type.name)}`}

  return 'i64'
}

// the sum (variant) types of a program: a record-type with variants. Each label maps to its owner, tag, and single
// payload field. Variants with two or more fields are not lowered here (their construction emits an explicit gap).
function variantLayouts(program: Program): {
  owners: Set<string>
  of: VariantOf
} {
  const owners = new Set<string>()
  const of: VariantOf = new Map()

  for (const s of program)
    {if (s.form === 'record-type' && s.variants.length > 0) {
      owners.add(s.name)
      s.variants.forEach((variant, tag) => {
        of.set(variant.name, {
          owner: s.name,
          tag,
          field: variant.fields[0],
        })
      })
    }}

  return { owners, of }
}

// the plain-record (product) types of a program, indexed by name: a record-type with fields and no variants. Sum types
// (variants) stay scalar for now; only fixed-shape products lower to an LLVM struct.
function recordLayouts(program: Program): Map<string, RecordLayout> {
  const records = new Map<string, RecordLayout>()

  for (const s of program)
    {if (
      s.form === 'record-type' &&
      s.variants.length === 0 &&
      s.fields.length > 0
    )
      {records.set(s.name, { fields: s.fields })}}

  return records
}

type Closure = Extract<Expression, { form: 'closure' }>
type Capture = { name: string; type?: Type }

// the variables a closure captures from its enclosing scope: every variable it references that is bound (a parameter or
// local) outside the closure, minus its own parameters and the locals it declares. These become the closure's saved
// environment.
function freeVars(closure: Closure): Capture[] {
  const bound = new Set(closure.params.map(p => p.name))
  const captures = new Map<string, Type | undefined>()

  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'variable':
        if (
          !bound.has(node.name) &&
          (node.binding?.kind === 'parameter' ||
            node.binding?.kind === 'local') &&
          !captures.has(node.name)
        )
          {captures.set(node.name, node.type)}

        break
      case 'call':
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

        if (node.otherwise) {expr(node.otherwise)}

        break
      case 'closure':
        // a nested closure's own free variables, if still unbound here, are captured by this closure too
        for (const inner of freeVars(node))
          {if (!bound.has(inner.name) && !captures.has(inner.name))
            {captures.set(inner.name, inner.type)}}

        break
      default:
        break
    }
  }

  const one = (s: Statement): void => {
    switch (s.form) {
      case 'let':
        expr(s.init)
        bound.add(s.name)
        break
      case 'assign':
        expr(s.target)
        expr(s.value)
        break
      case 'expression':
        expr(s.expr)
        break
      case 'return':
        if (s.value) {expr(s.value)}

        break
      case 'throw':
        expr(s.value)
        break
      case 'hold':
        expr(s.expr)
        break
      case 'while':
        expr(s.cond)
        s.body.forEach(one)
        break
      case 'for-each':
        expr(s.iterable)
        s.body.forEach(one)
        break
      case 'if':
        s.branches.forEach(b => {
          expr(b.cond)
          b.body.forEach(one)
        })

        if (s.otherwise) {s.otherwise.forEach(one)}

        break
      case 'match':
        expr(s.subject)
        s.cases.forEach(c => c.body.forEach(one))

        if (s.otherwise) {s.otherwise.forEach(one)}

        break
      default:
        break
    }
  }

  closure.body.forEach(one)

  return [...captures].map(([name, type]) => ({ name, type }))
}

// the runtime the emitted IR calls for string operations (declared at the top of every module)
const RUNTIME_DECLS = [
  'declare ptr @seed_str_concat(ptr, ptr)',
  'declare i64 @seed_str_length(ptr)',
  'declare i64 @seed_str_equal(ptr, ptr)',
  'declare void @seed_rc_init(ptr)',
  'declare void @seed_dup(ptr)',
  'declare void @seed_drop(ptr, i64)',
  'declare void @seed_print_str(ptr)',
  'declare void @seed_print_int(i64)',
  'declare ptr @seed_list_new()',
  'declare i64 @seed_list_push(ptr, i64)',
  'declare i64 @seed_list_at(ptr, i64)',
  'declare i64 @seed_list_length(ptr)',
  'declare i64 @seed_list_pop(ptr)',
  'declare i64 @seed_list_includes(ptr, i64)',
  'declare i64 @seed_list_index_of(ptr, i64)',
  'declare ptr @seed_list_map(ptr, ptr, ptr)',
  'declare ptr @seed_list_filter(ptr, ptr, ptr)',
  'declare i64 @seed_list_reduce(ptr, ptr, ptr, i64)',
  'declare i64 @seed_list_some(ptr, ptr, ptr)',
  'declare i64 @seed_list_every(ptr, ptr, ptr)',
  'declare ptr @seed_map_new()',
  'declare ptr @seed_map_set(ptr, i64, i64, i64)',
  'declare i64 @seed_map_get(ptr, i64, i64)',
  'declare i64 @seed_map_has(ptr, i64, i64)',
  'declare i64 @seed_map_delete(ptr, i64, i64)',
  'declare i64 @seed_map_size(ptr)',
  'declare ptr @seed_map_keys(ptr)',
  'declare ptr @seed_map_values(ptr)',
]

export function emitLlvm(input: Program): string {
  // LLVM has no type parameters: specialize every generic function at its concrete call types and drop the generic
  // originals first, so a generic call resolves to a real monomorphic function instead of being silently skipped.
  const program = monomorphize(input)
  // module-level string constants, interned by content
  const globals: string[] = []
  const interned = new Map<string, string>()

  const internString = (value: string): string => {
    const existing = interned.get(value)

    if (existing) {return existing}

    const name = `@.str.${interned.size}`
    const bytes = [...Buffer.from(value, 'utf8')]
    const escaped = bytes
      .map(b =>
        b >= 0x20 && b < 0x7f && b !== 0x22 && b !== 0x5c
          ? String.fromCharCode(b)
          : `\\${b.toString(16).padStart(2, '0')}`,
      )
      .join('')

    globals.push(
      `${name} = private unnamed_addr constant [${
        bytes.length + 1
      } x i8] c"${escaped}\\00"`,
    )
    interned.set(value, name)

    return name
  }

  // plain records lower to named LLVM struct types, declared once at module scope
  const records = recordLayouts(program)
  const variants = variantLayouts(program)
  const structDecls: string[] = []

  for (const [name, layout] of records)
    {structDecls.push(
      `%struct.${mangle(name)} = type { ${layout.fields
        .map(f => llty(f.type, records, variants.owners))
        .join(', ')} }`,
    )}

  // lifted closure functions accumulate here as they are encountered inside any function body; closureId keeps their
  // names unique module-wide. They are appended after the user's functions.
  const lifted: string[] = []
  const closureId = { n: 0 }
  const functions: string[] = []

  for (const s of program) {
    if (s.form !== 'function' || s.generics.length > 0) {continue} // generic functions are removed by monomorphization

    functions.push(
      emitFunction(
        s,
        internString,
        records,
        lifted,
        closureId,
        [],
        false,
        variants,
      ),
    )
  }

  return (
    [
      ...RUNTIME_DECLS,
      '',
      ...(structDecls.length ? [...structDecls, ''] : []),
      ...globals,
      globals.length ? '' : null,
      ...functions,
      ...lifted,
    ]
      .filter(l => l !== null)
      .join('\n') + '\n'
  )
}

function emitFunction(
  fn: Extract<Statement, { form: 'function' }>,
  internString: (value: string) => string,
  records = new Map<string, RecordLayout>(),
  lifted: string[] = [],
  closureId: { n: number } = { n: 0 },
  captures: Capture[] = [], // the env words a lifted closure unpacks at entry (may be empty)
  isClosure = false, // a lifted closure ALWAYS takes a leading `ptr %env`, even with no captures, for a uniform ABI
  variants: { owners: Set<string>; of: VariantOf } = {
    owners: new Set(),
    of: new Map(),
  },
): string {
  // record/variant-aware type lowering, used everywhere so a record gets `%struct.Name` and a sum type the tagged union
  const llt = (type: Type | undefined): LlvmType =>
    llty(type, records, variants.owners)

  // variant payloads bound in the current match arm: `<subjectVar>/<field>` -> the extracted value (for member reads)
  const variantBindings = new Map<string, string>()

  // a list stores every element as an i64 word, so a non-integer scalar is reinterpreted to / from i64 at the boundary:
  // a float bit-casts, a pointer (string handle) converts with ptrtoint / inttoptr.
  const toWord = (reg: string, type: Type | undefined): string => {
    const t = llt(type)

    if (t === 'double') {
      const w = fresh()
      cur.lines.push(`${w} = bitcast double ${reg} to i64`)

      return w
    }

    if (t === 'ptr') {
      const w = fresh()
      cur.lines.push(`${w} = ptrtoint ptr ${reg} to i64`)

      return w
    }

    return reg
  }

  const fromWord = (reg: string, type: Type | undefined): string => {
    const t = llt(type)

    if (t === 'double') {
      const v = fresh()
      cur.lines.push(`${v} = bitcast i64 ${reg} to double`)

      return v
    }

    if (t === 'ptr') {
      const v = fresh()
      cur.lines.push(`${v} = inttoptr i64 ${reg} to ptr`)

      return v
    }

    return reg
  }

  // the element type of an array-typed expression (for word conversion)
  const elementOf = (node: Expression): Type | undefined =>
    node.type?.kind === 'array' ? node.type.element : undefined

  let temp = 0
  let labelN = 0
  let condN = 0

  const fresh = () => `%t${temp++}`
  const freshLabel = (base: string) => `${base}${labelN++}`
  const blocks: {
    name: string
    lines: string[]
    done: boolean
  }[] = []

  const block = (name: string) => {
    const b = { name, lines: [], done: false } as {
      name: string
      lines: string[]
      done: boolean
    }

    blocks.push(b)

    return b
  }

  let cur = block('entry')

  // every local lives in a typed stack slot, allocated once in the entry block
  const allocas: string[] = []
  const slot = new Map<string, { reg: string; ty: LlvmType }>()

  const ensureSlot = (
    name: string,
    ty: LlvmType,
  ): { reg: string; ty: LlvmType } => {
    let s = slot.get(name)

    if (!s) {
      s = { reg: `%${mangle(name)}.addr`, ty }
      slot.set(name, s)
      allocas.push(`${s.reg} = alloca ${ty}`)
    }

    return s
  }

  // drop-safe heap locals: single-owner string / list / map locals that no use consumes (every use borrows). Each is
  // freed once at every function exit. Records / bytes are not runtime-heap pointers, so they are skipped. The slots
  // are null-initialized at entry, so an uninitialized one (an early return before its `save`) drops as a harmless
  // no-op (`seed_drop` ignores a null / untracked pointer). Because these locals are single-owner, dropping cannot
  // double-free; anything the analysis does not classify stays leaked exactly as before (no regression).
  const DROP_TAG: Record<string, number> = { string: 0, array: 1, map: 2 }
  const heapTypeOf = new Map<string, Type>()

  const collectLetTypes = (body: Statement[]): void => {
    for (const s of body) {
      if (s.form === 'let') {
        const t = s.init.type ?? s.type
        if (t) {heapTypeOf.set(s.name, t)}
      }

      if (s.form === 'if') {
        for (const b of s.branches) {collectLetTypes(b.body)}
        if (s.otherwise) {collectLetTypes(s.otherwise)}
      } else if (s.form === 'while' || s.form === 'for-each') {
        collectLetTypes(s.body)
      } else if (s.form === 'match') {
        for (const c of s.cases) {collectLetTypes(c.body)}
        if (s.otherwise) {collectLetTypes(s.otherwise)}
      }
    }
  }

  collectLetTypes(fn.body)

  const dropList = [...dropSafeHeapLocals(fn)]
    .map(name => ({
      name,
      tag: DROP_TAG[heapTypeOf.get(name)?.kind ?? ''],
    }))
    .filter((d): d is { name: string; tag: number } => d.tag !== undefined)

  const entryInits: string[] = []

  for (const d of dropList) {
    const s = ensureSlot(d.name, 'ptr')
    entryInits.push(`store ptr null, ptr ${s.reg}`)
  }

  // free every drop-safe local; emitted just before each `ret`
  const emitExitDrops = (): void => {
    for (const d of dropList) {
      const s = slot.get(d.name)

      if (!s) {continue}

      const v = fresh()
      cur.lines.push(`${v} = load ptr, ptr ${s.reg}`)
      cur.lines.push(`call void @seed_drop(ptr ${v}, i64 ${d.tag})`)
    }
  }

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a double constant needs a decimal point (`3` is an i64 literal, `3.0` is a double)
        return Number.isInteger(node.value)
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? '1' : '0'
      case 'string':
        return internString(node.value) // a global constant; its address is the string pointer
      case 'unit':
        return '0'
      case 'variable':

      case 'hole': {
        const s = slot.get(node.name)

        if (!s) {return '0'}

        const t = fresh()
        cur.lines.push(`${t} = load ${s.ty}, ptr ${s.reg}`)

        return t
      }

      case 'unary': {
        const v = expr(node.operand)
        const t = fresh()

        if (node.op === '-') {
          cur.lines.push(
            node.operand.type?.kind === 'float'
              ? `${t} = fneg double ${v}`
              : `${t} = sub i64 0, ${v}`,
          )
        } else {
          const c = fresh()
          cur.lines.push(`${c} = icmp eq i64 ${v}, 0`)
          cur.lines.push(`${t} = zext i1 ${c} to i64`)
        }

        return t
      }

      case 'binary': {
        // string operands route to the runtime; numeric operands to native instructions
        if (node.left.type?.kind === 'string') {
          const l = expr(node.left)
          const r = expr(node.right)

          if (node.op === '+') {
            const t = fresh()
            cur.lines.push(
              `${t} = call ptr @seed_str_concat(ptr ${l}, ptr ${r})`,
            )
            // register the fresh heap string with the refcount table (count 1) so a later drop can free it
            cur.lines.push(`call void @seed_rc_init(ptr ${t})`)

            return t
          }

          if (node.op === '==' || node.op === '!=') {
            const e = fresh()
            cur.lines.push(
              `${e} = call i64 @seed_str_equal(ptr ${l}, ptr ${r})`,
            )

            if (node.op === '==') {return e}

            const t = fresh()
            cur.lines.push(`${t} = xor i64 ${e}, 1`)

            return t
          }

          cur.lines.push(unsupported('LLVM', `string ${node.op}`, ';'))

          return '0'
        }

        const l = expr(node.left)
        const r = expr(node.right)
        const t = fresh()
        // float operands use the floating-point instructions on `double`; integers use the i64 ones
        const isFloat =
          node.left.type?.kind === 'float' ||
          node.right.type?.kind === 'float'

        if (ARITH[node.op]) {
          cur.lines.push(
            isFloat
              ? `${t} = ${FARITH[node.op]} double ${l}, ${r}`
              : `${t} = ${ARITH[node.op]} i64 ${l}, ${r}`,
          )

          return t
        }

        if (PRED[node.op]) {
          const c = fresh()
          cur.lines.push(
            isFloat
              ? `${c} = fcmp ${FPRED[node.op]} double ${l}, ${r}`
              : `${c} = icmp ${PRED[node.op]} i64 ${l}, ${r}`,
          )
          cur.lines.push(`${t} = zext i1 ${c} to i64`)

          return t
        }

        const la = fresh()
        const ra = fresh()
        const c = fresh()
        cur.lines.push(`${la} = icmp ne i64 ${l}, 0`)
        cur.lines.push(`${ra} = icmp ne i64 ${r}, 0`)
        cur.lines.push(
          `${c} = ${node.op === '&&' ? 'and' : 'or'} i1 ${la}, ${ra}`,
        )
        cur.lines.push(`${t} = zext i1 ${c} to i64`)

        return t
      }

      case 'call': {
        // a list method (`xs.push(v)`, `xs.at(i)`, ...) lowers to a `seed_list_*` runtime call. Elements move as i64
        // words, so a non-integer element is converted at the boundary. Closure ops (map / reduce / ...) need LLVM
        // closures and stay unsupported; the imperative ops are complete here.
        const collection = collectionCall(node.callee)

        if (collection?.kind === 'array') {
          const handle = expr(collection.target)
          const element = elementOf(collection.target)

          const listCall = (
            fn: string,
            extra: string[],
          ): string => {
            const out = fresh()
            cur.lines.push(
              `${out} = call i64 @${fn}(ptr ${handle}${extra
                .map(a => `, ${a}`)
                .join('')})`,
            )

            return out
          }

          switch (collection.op) {
            case 'push':
              return listCall('seed_list_push', [
                `i64 ${toWord(expr(node.args[0]!), element)}`,
              ])
            case 'at':
              return fromWord(
                listCall('seed_list_at', [
                  `i64 ${expr(node.args[0]!)}`,
                ]),
                element,
              )
            case 'pop':
              return fromWord(listCall('seed_list_pop', []), element)
            case 'includes':
              return listCall('seed_list_includes', [
                `i64 ${toWord(expr(node.args[0]!), element)}`,
              ])
            case 'indexOf':
              return listCall('seed_list_index_of', [
                `i64 ${toWord(expr(node.args[0]!), element)}`,
              ])
            // closure-taking ops: pass the closure's { code, env } as two pointers; the runtime calls it per element
            case 'map':
            case 'filter':
            case 'some':

            case 'every': {
              const closure = expr(node.args[0]!)
              const fnPtr = fresh()
              cur.lines.push(
                `${fnPtr} = extractvalue ${CLOSURE_TYPE} ${closure}, 0`,
              )

              const envPtr = fresh()
              cur.lines.push(
                `${envPtr} = extractvalue ${CLOSURE_TYPE} ${closure}, 1`,
              )

              const ret =
                collection.op === 'map' || collection.op === 'filter'
                  ? 'ptr'
                  : 'i64'

              const out = fresh()
              cur.lines.push(
                `${out} = call ${ret} @seed_list_${collection.op}(ptr ${handle}, ptr ${fnPtr}, ptr ${envPtr})`,
              )

              return out
            }

            case 'reduce': {
              const closure = expr(node.args[0]!)
              const fnPtr = fresh()
              cur.lines.push(
                `${fnPtr} = extractvalue ${CLOSURE_TYPE} ${closure}, 0`,
              )

              const envPtr = fresh()
              cur.lines.push(
                `${envPtr} = extractvalue ${CLOSURE_TYPE} ${closure}, 1`,
              )

              const init = toWord(expr(node.args[1]!), node.type)
              const out = fresh()
              cur.lines.push(
                `${out} = call i64 @seed_list_reduce(ptr ${handle}, ptr ${fnPtr}, ptr ${envPtr}, i64 ${init})`,
              )

              return fromWord(out, node.type)
            }

            default:
              cur.lines.push(
                unsupported('LLVM', `list.${collection.op}`, ';'),
              )

              return '0'
          }
        }

        // a map method (`m.set(k, v)`, `m.get(k)`, ...) lowers to a `seed_map_*` runtime call. The key kind (0 integer,
        // 1 string) tells the runtime how to compare keys by value; key and value move as i64 words.
        if (collection?.kind === 'map') {
          const handle = expr(collection.target)
          const mapType = collection.target.type
          const keyType =
            mapType?.kind === 'map' ? mapType.key : undefined

          const valueType =
            mapType?.kind === 'map' ? mapType.value : undefined

          const keyKind = keyType?.kind === 'string' ? 1 : 0
          const key = () =>
            `i64 ${toWord(expr(node.args[0]!), keyType)}`

          switch (collection.op) {
            case 'set': {
              const value = toWord(expr(node.args[1]!), valueType)
              const out = fresh()
              cur.lines.push(
                `${out} = call ptr @seed_map_set(ptr ${handle}, i64 ${keyKind}, ${key()}, i64 ${value})`,
              )

              return out
            }

            case 'get': {
              const out = fresh()
              cur.lines.push(
                `${out} = call i64 @seed_map_get(ptr ${handle}, i64 ${keyKind}, ${key()})`,
              )

              return fromWord(out, valueType)
            }

            case 'has':

            case 'delete': {
              const fn =
                collection.op === 'has'
                  ? 'seed_map_has'
                  : 'seed_map_delete'

              const out = fresh()
              cur.lines.push(
                `${out} = call i64 @${fn}(ptr ${handle}, i64 ${keyKind}, ${key()})`,
              )

              return out
            }

            case 'keys':

            case 'values': {
              const out = fresh()
              cur.lines.push(
                `${out} = call ptr @seed_map_${collection.op}(ptr ${handle})`,
              )

              return out
            }

            default:
              cur.lines.push(
                unsupported('LLVM', `map.${collection.op}`, ';'),
              )

              return '0'
          }
        }

        // an indirect call through a closure VALUE (a function-typed parameter or local, not a top-level function):
        // unpack the { code, env } pair and call the code pointer with the env threaded as the leading argument.
        if (
          node.callee.type?.kind === 'function' &&
          !(
            node.callee.form === 'variable' &&
            node.callee.binding?.kind === 'function'
          )
        ) {
          const value = expr(node.callee)
          const fnPtr = fresh()
          cur.lines.push(
            `${fnPtr} = extractvalue ${CLOSURE_TYPE} ${value}, 0`,
          )

          const envPtr = fresh()
          cur.lines.push(
            `${envPtr} = extractvalue ${CLOSURE_TYPE} ${value}, 1`,
          )

          const callArgs = [
            `ptr ${envPtr}`,
            ...node.args.map(a => `${llt(a.type)} ${expr(a)}`),
          ].join(', ')

          const retType = llt(node.type)

          if (retType === 'void') {
            cur.lines.push(`call void ${fnPtr}(${callArgs})`)

            return '0'
          }

          const out = fresh()
          cur.lines.push(
            `${out} = call ${retType} ${fnPtr}(${callArgs})`,
          )

          return out
        }

        // a couple of builtins lower straight to the runtime; everything else is a direct call, args typed by value
        const callee =
          node.callee.form === 'variable'
            ? mangle(node.callee.name)
            : '0'

        if (
          (callee === 'length' || callee === 'size') &&
          node.args[0]?.type?.kind === 'string'
        ) {
          const t = fresh()
          cur.lines.push(
            `${t} = call i64 @seed_str_length(ptr ${expr(
              node.args[0],
            )})`,
          )

          return t
        }

        const args = node.args.map(a => `${llt(a.type)} ${expr(a)}`)
        const retType = llt(node.type)

        if (retType === 'void') {
          cur.lines.push(`call void @${callee}(${args.join(', ')})`)

          return '0'
        }

        const t = fresh()
        cur.lines.push(
          `${t} = call ${retType} @${callee}(${args.join(', ')})`,
        )

        return t
      }

      // a value-position conditional (a `fork` used as a value) lowers like clang -O0 does a ternary: a result stack
      // slot written from each arm's block, then loaded at the merge -- the same alloca model the rest of the backend
      // uses, so no SSA phi node is needed. The condition / then chain mirrors the `if` statement lowering.
      case 'conditional': {
        const ty = llt(node.type)
        const resultSlot = `%cond${condN++}.addr`
        allocas.push(`${resultSlot} = alloca ${ty}`)

        const merge = freshLabel('cond.merge')

        const storeArm = (value: Expression) => {
          const v = expr(value)

          if (!cur.done) {
            if (ty !== 'void')
              {cur.lines.push(`store ${ty} ${v}, ptr ${resultSlot}`)}

            cur.lines.push(`br label %${merge}`)
            cur.done = true
          }
        }

        for (const branch of node.branches) {
          const c = condition(branch.cond)
          const thenL = freshLabel('cond.then')
          const nextL = freshLabel('cond.next')
          cur.lines.push(`br i1 ${c}, label %${thenL}, label %${nextL}`)
          cur.done = true
          cur = block(thenL)
          storeArm(branch.value)
          cur = block(nextL)
        }

        // a value conditional always has an else (it must yield a value on every path); fall back to a zero store
        if (node.otherwise) {storeArm(node.otherwise)}
        else if (!cur.done) {
          if (ty !== 'void')
            {cur.lines.push(`store ${ty} 0, ptr ${resultSlot}`)}

          cur.lines.push(`br label %${merge}`)
          cur.done = true
        }

        cur = block(merge)

        if (ty === 'void') {return '0'}

        const out = fresh()
        cur.lines.push(`${out} = load ${ty}, ptr ${resultSlot}`)

        return out
      }

      // a plain record literal builds a first-class struct value via an `insertvalue` chain over `undef`, in the
      // record-type's declared field order (the literal's fields may be written in any order).
      case 'record': {
        // a variant constructor (`make some / bind value, x`) builds the tagged union { tag, payload }
        const variant = variants.of.get(node.name)

        if (variant) {
          let payload = '0'

          if (variant.field) {
            const written = node.fields.find(
              f => f.name === variant.field!.name,
            )

            if (written)
              {payload = toWord(expr(written.value), variant.field.type)}
          }

          const v0 = fresh()
          cur.lines.push(
            `${v0} = insertvalue ${VARIANT_TYPE} undef, i64 ${variant.tag}, 0`,
          )

          const v1 = fresh()
          cur.lines.push(
            `${v1} = insertvalue ${VARIANT_TYPE} ${v0}, i64 ${payload}, 1`,
          )

          return v1
        }

        const layout = records.get(node.name)

        if (!layout) {
          cur.lines.push(
            unsupported('LLVM', `record ${node.name}`, ';'),
          )

          return '0'
        }

        const structTy = `%struct.${mangle(node.name)}`

        let acc = 'undef'
        layout.fields.forEach((field, index) => {
          const written = node.fields.find(f => f.name === field.name)
          const value = written ? expr(written.value) : '0'
          const next = fresh()
          cur.lines.push(
            `${next} = insertvalue ${structTy} ${acc}, ${llt(
              field.type,
            )} ${value}, ${index}`,
          )
          acc = next
        })

        return acc
      }

      // a field read off a record is an `extractvalue` at the field's declared index
      case 'member': {
        // inside a match arm, `subject/field` reads the variant payload bound for this arm
        if (node.target.form === 'variable') {
          const bound = variantBindings.get(
            `${node.target.name}/${node.name}`,
          )

          if (bound !== undefined) {return bound}
        }

        // `xs.length` on a list / `m.size` on a map reads the runtime count
        const read = collectionRead(node)

        if (read?.kind === 'array') {
          const handle = expr(read.target)
          const out = fresh()
          cur.lines.push(
            `${out} = call i64 @seed_list_length(ptr ${handle})`,
          )

          return out
        }

        if (read?.kind === 'map') {
          const handle = expr(read.target)
          const out = fresh()
          cur.lines.push(
            `${out} = call i64 @seed_map_size(ptr ${handle})`,
          )

          return out
        }

        const targetType = node.target.type
        const recordName =
          targetType?.kind === 'named' ? targetType.name : undefined

        const layout = recordName ? records.get(recordName) : undefined
        const index = layout
          ? layout.fields.findIndex(f => f.name === node.name)
          : -1

        if (!layout || index < 0) {
          cur.lines.push(
            unsupported('LLVM', `member ${node.name}`, ';'),
          )

          return '0'
        }

        const target = expr(node.target)
        const out = fresh()
        cur.lines.push(
          `${out} = extractvalue %struct.${mangle(
            recordName!,
          )} ${target}, ${index}`,
        )

        return out
      }

      // a list literal allocates a fresh handle and pushes each element (as an i64 word) in order
      case 'array': {
        const element =
          node.type?.kind === 'array' ? node.type.element : undefined

        const handle = fresh()
        cur.lines.push(`${handle} = call ptr @seed_list_new()`)
        cur.lines.push(`call void @seed_rc_init(ptr ${handle})`)

        for (const item of node.items) {
          const word = toWord(expr(item), element ?? item.type)
          const len = fresh()
          cur.lines.push(
            `${len} = call i64 @seed_list_push(ptr ${handle}, i64 ${word})`,
          )
        }

        return handle
      }

      // a closure literal: save the captured variables into a fresh environment list, lift the body to a top-level
      // function that unpacks that env, and return the { code pointer, env handle } pair.
      case 'closure': {
        const caps = freeVars(node)
        const name = `closure_${closureId.n++}`
        const env = fresh()
        cur.lines.push(`${env} = call ptr @seed_list_new()`)

        for (const cap of caps) {
          const s = ensureSlot(cap.name, llt(cap.type))
          const loaded = fresh()
          cur.lines.push(
            `${loaded} = load ${llt(cap.type)}, ptr ${s.reg}`,
          )

          const word = toWord(loaded, cap.type)
          const len = fresh()
          cur.lines.push(
            `${len} = call i64 @seed_list_push(ptr ${env}, i64 ${word})`,
          )
        }

        const synth = {
          form: 'function',
          name,
          generics: [],
          params: node.params,
          result: node.result,
          body: node.body,
          span: node.span,
          async: false,
        } as Extract<Statement, { form: 'function' }>

        lifted.push(
          emitFunction(
            synth,
            internString,
            records,
            lifted,
            closureId,
            caps,
            true,
          ),
        )

        const v0 = fresh()
        cur.lines.push(
          `${v0} = insertvalue ${CLOSURE_TYPE} undef, ptr @${name}, 0`,
        )

        const v1 = fresh()
        cur.lines.push(
          `${v1} = insertvalue ${CLOSURE_TYPE} ${v0}, ptr ${env}, 1`,
        )

        return v1
      }

      // a map literal allocates a fresh hash and sets each entry (key + value as i64 words)
      case 'map': {
        const keyType =
          node.type?.kind === 'map' ? node.type.key : undefined

        const valueType =
          node.type?.kind === 'map' ? node.type.value : undefined

        const keyKind = keyType?.kind === 'string' ? 1 : 0
        const handle = fresh()
        cur.lines.push(`${handle} = call ptr @seed_map_new()`)
        cur.lines.push(`call void @seed_rc_init(ptr ${handle})`)

        for (const entry of node.entries) {
          const key = toWord(expr(entry.key), keyType)
          const value = toWord(expr(entry.value), valueType)
          const next = fresh()
          cur.lines.push(
            `${next} = call ptr @seed_map_set(ptr ${handle}, i64 ${keyKind}, i64 ${key}, i64 ${value})`,
          )
        }

        return handle
      }

      case 'await':
      case 'null':
        cur.lines.push(unsupported('LLVM', node.form, ';'))

        return '0'
      default:
        return exhausted(node)
    }
  }

  // an expression used as a branch condition, reduced to an i1 (non-zero is true)
  const condition = (node: Expression): string => {
    const v = expr(node)
    const c = fresh()
    cur.lines.push(`${c} = icmp ne i64 ${v}, 0`)

    return c
  }

  const stmt = (node: Statement): void => {
    if (cur.done) {cur = block(freshLabel('dead'))}

    switch (node.form) {
      case 'let': {
        const ty = llt(node.type ?? node.init.type)
        const s = ensureSlot(node.name, ty)
        const v = expr(node.init)
        cur.lines.push(`store ${ty} ${v}, ptr ${s.reg}`)
        break
      }

      case 'assign': {
        if (node.target.form !== 'variable') {
          cur.lines.push(unsupported('LLVM', 'assign', ';'))
          break
        }

        const ty = llt(node.value.type)
        const s = ensureSlot(node.target.name, ty)

        let v: string

        if (node.op === '=') {
          v = expr(node.value)
        } else if (s.ty === 'ptr' && node.op === '+=') {
          // string append
          const old = fresh()
          cur.lines.push(`${old} = load ptr, ptr ${s.reg}`)

          const rhs = expr(node.value)
          const t = fresh()
          cur.lines.push(
            `${t} = call ptr @seed_str_concat(ptr ${old}, ptr ${rhs})`,
          )
          v = t
        } else {
          const old = fresh()
          cur.lines.push(`${old} = load ${s.ty}, ptr ${s.reg}`)

          const rhs = expr(node.value)
          const t = fresh()
          const op = node.op[0]!
          cur.lines.push(
            `${t} = ${s.ty === 'double' ? FARITH[op] : ARITH[op]} ${
              s.ty
            } ${old}, ${rhs}`,
          )
          v = t
        }

        cur.lines.push(`store ${s.ty} ${v}, ptr ${s.reg}`)
        break
      }

      case 'return':
        if (!node.value) {
          emitExitDrops()
          cur.lines.push('ret void')
        } else {
          // the returned value must match the function's DECLARED result type, not the (sometimes under-inferred)
          // expression type: a stdlib body like `send back self.map(fn)` types the call as the element word, but the
          // function returns a list (ptr). The declared result is the LLVM contract the call site relies on.
          const ty = llt(fn.result)
          // evaluate the value BEFORE referencing cur.lines: a value-position conditional emits its own blocks and
          // moves `cur` to the merge block, so the `ret` must land there, not in whatever block we started in.
          // Drop the single-owner locals AFTER computing the return value (a borrow of one may feed the value).
          const v = expr(node.value)
          emitExitDrops()
          cur.lines.push(`ret ${ty} ${v}`)
        }

        cur.done = true
        break
      case 'expression':
        expr(node.expr)
        break

      case 'if': {
        const merge = freshLabel('merge')

        let fellThrough = false

        const chain = (i: number): void => {
          if (i >= node.branches.length) {
            if (node.otherwise) {node.otherwise.forEach(stmt)}

            if (!cur.done) {
              cur.lines.push(`br label %${merge}`)
              cur.done = true
              fellThrough = true
            }

            return
          }

          const c = condition(node.branches[i]!.cond)
          const thenL = freshLabel('then')
          const nextL = freshLabel('next')
          cur.lines.push(`br i1 ${c}, label %${thenL}, label %${nextL}`)
          cur.done = true
          cur = block(thenL)
          node.branches[i]!.body.forEach(stmt)

          if (!cur.done) {
            cur.lines.push(`br label %${merge}`)
            cur.done = true
            fellThrough = true
          }

          cur = block(nextL)
          chain(i + 1)
        }

        chain(0)

        if (fellThrough) {cur = block(merge)}

        break
      }

      case 'while': {
        const condL = freshLabel('while.cond')
        const bodyL = freshLabel('while.body')
        const endL = freshLabel('while.end')
        cur.lines.push(`br label %${condL}`)
        cur.done = true
        cur = block(condL)

        const c = condition(node.cond)
        cur.lines.push(`br i1 ${c}, label %${bodyL}, label %${endL}`)
        cur.done = true
        cur = block(bodyL)
        node.body.forEach(stmt)

        if (!cur.done) {cur.lines.push(`br label %${condL}`)}

        cur.done = true
        cur = block(endL)
        break
      }

      case 'hold':
        cur.lines.push('; hold: verified at compile time')
        break

      // a pattern match on a sum type: read the tag, branch per variant, bind the payload in each arm
      case 'match': {
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined

        const subject = expr(node.subject)
        const tag = fresh()
        cur.lines.push(
          `${tag} = extractvalue ${VARIANT_TYPE} ${subject}, 0`,
        )

        const merge = freshLabel('match.end')

        for (const arm of node.cases) {
          const info = variants.of.get(arm.label)
          const cmp = fresh()
          cur.lines.push(
            `${cmp} = icmp eq i64 ${tag}, ${info?.tag ?? -1}`,
          )

          const armL = freshLabel('arm')
          const nextL = freshLabel('arm.next')
          cur.lines.push(
            `br i1 ${cmp}, label %${armL}, label %${nextL}`,
          )
          cur.done = true
          cur = block(armL)

          // bind the payload so a `subject/field` read in this arm resolves to it (restored after the arm)
          let restore: [string, string | undefined] | undefined

          if (info?.field && subjectVar) {
            const pay = fresh()
            cur.lines.push(
              `${pay} = extractvalue ${VARIANT_TYPE} ${subject}, 1`,
            )

            const value = fromWord(pay, info.field.type)
            const key = `${subjectVar}/${info.field.name}`
            restore = [key, variantBindings.get(key)]
            variantBindings.set(key, value)
          }

          arm.body.forEach(s => stmt(s))

          if (restore) {
            if (restore[1] === undefined)
              {variantBindings.delete(restore[0])}
            else {variantBindings.set(restore[0], restore[1])}
          }

          if (!cur.done) {
            cur.lines.push(`br label %${merge}`)
            cur.done = true
          }

          cur = block(nextL)
        }

        if (node.otherwise) {node.otherwise.forEach(s => stmt(s))}

        if (!cur.done) {
          cur.lines.push(`br label %${merge}`)
          cur.done = true
        }

        cur = block(merge)
        break
      }

      case 'for-each':
      case 'throw':
      case 'break':
      case 'continue':
      case 'exit':
      case 'debug':
      case 'function':
      case 'record-type':
      case 'mask':
      case 'instance':
      case 'native':
        cur.lines.push(unsupported('LLVM', node.form, ';'))
        break
      case 'bind':
      case 'zone':
      case 'dock':
        break // view / routing DSLs are lowered by the dedicated zone compiler, not this backend
      default:
        exhausted(node)
    }
  }

  // a lifted closure receives its saved environment as a leading `ptr %env`: unpack each captured word back into a
  // slot at entry (the inverse of the literal's env-push), so the body reads a capture exactly like a local.
  captures.forEach((cap, index) => {
    const word = fresh()
    cur.lines.push(
      `${word} = call i64 @seed_list_at(ptr %env, i64 ${index})`,
    )

    const value = fromWord(word, cap.type)
    const s = ensureSlot(cap.name, llt(cap.type))
    cur.lines.push(`store ${llt(cap.type)} ${value}, ptr ${s.reg}`)
  })

  // parameters: spill each incoming SSA argument into its (typed) stack slot at entry
  for (const p of fn.params) {
    const ty = llt(p.type)
    const s = ensureSlot(p.name, ty)
    cur.lines.push(`store ${ty} %${mangle(p.name)}, ptr ${s.reg}`)
  }

  fn.body.forEach(stmt)

  if (!cur.done) {
    // the implicit fall-off return: free the single-owner locals before it too
    emitExitDrops()
    cur.lines.push(llt(fn.result) === 'void' ? 'ret void' : 'ret i64 0')
  }

  // allocas first, then the null-init of each drop-safe slot, then the body -- so an uninitialized local reads null
  blocks[0]!.lines = [...allocas, ...entryInits, ...blocks[0]!.lines]

  const params = [
    ...(isClosure ? ['ptr %env'] : []),
    ...fn.params.map(p => `${llt(p.type)} %${mangle(p.name)}`),
  ].join(', ')

  const retType = llt(fn.result)
  const body = blocks
    .map(b => `${b.name}:\n${b.lines.map(l => `  ${l}`).join('\n')}`)
    .join('\n')

  return `define ${retType} @${mangle(
    fn.name,
  )}(${params}) {\n${body}\n}`
}
