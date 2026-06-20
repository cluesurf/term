// The Rust backend: emit the language as Rust. Parity with the other backends across every AST form. The scalar +
// control-flow fragment (functions, arithmetic, if, while, recursion, reassignment via `let mut` + shadowing of
// reassigned params) compiles cleanly with rustc; algebraic data types lower to native `enum`s and structs to
// `struct`s, with `match`. Strings are `String`, numbers `i64`. Native `dock` bindings become `use` + `module::fn`
// calls. Constructs that need ownership care beyond this fragment (closures capturing the environment) emit an
// explicit SEED-UNSUPPORTED marker rather than miscompiling. Pure, browser-safe.

import type {
  Expression,
  Program,
  Statement,
  Type,
} from '@/code/compile/node'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  collectionRead,
  exhausted,
  unsupported,
} from '@/code/compile/backend'
import type { CollectionOp } from '@/code/compile/backend'

// `self` is fine in Rust as a name only in methods; as a free identifier rename it. Names snake_case.
function vname(name: string): string {
  return name === 'self' ? 'slf' : name.replace(/-/g, '_')
}
function snake(name: string): string {
  return name.replace(/-/g, '_')
}
function pascal(name: string): string {
  return name.replace(/(^|-)([a-z])/g, (_, _d, c: string) =>
    c.toUpperCase(),
  )
}

// a function's free inference variables become named generic parameters; this maps each variable id to its letter for
// the duration of that function's emission, so a generic signature prints `T` / `U` rather than the `i64` default.
let rustVarNames = new Map<number, string>()

function rustType(type: Type | undefined): string {
  switch (type?.kind) {
    case 'boolean':
      return 'bool'
    case 'string':
      return 'String'
    case 'unit':
    case undefined:
      return '()'
    case 'array':
      return `Vec<${rustType(type.element)}>`
    case 'map':
      // a shared, interior-mutable handle, so a map mutated through one binding (a `set.insert`) is seen through every
      // binding even after the owning struct is moved. `Rc` is `Clone`, so passing a map shares it, never moving it.
      return `std::rc::Rc<std::cell::RefCell<std::collections::HashMap<${rustType(
        type.key,
      )}, ${rustType(type.value)}>>>`
    case 'named':
      return type.args && type.args.length > 0
        ? `${pascal(type.name)}<${type.args.map(rustType).join(', ')}>`
        : pascal(type.name)
    case 'function':
      // a boxed trait object, not `impl Fn`: this is the one function type that works in every position -- a
      // parameter, a return, a struct field, AND a collection element (`Vec<Box<dyn Fn>>`, `HashMap<_, Box<dyn Fn>>`).
      return `Box<dyn Fn(${type.params
        .map(rustType)
        .join(', ')}) -> ${rustType(type.result)}>`
    case 'number':
      return 'i64'
    case 'float':
      return 'f64'
    case 'dynamic':
      return 'serde_json::Value'
    case 'bytes':
      return 'Vec<u8>'
    case 'variable':
      // a free inference variable: its function's generic letter, or i64 when it is not in a generic position
      return rustVarNames.get(type.id) ?? 'i64'
    case 'unknown':
      return 'i64'
    default:
      return 'i64'
  }
}

// collect the inference-variable ids appearing in a type (each an implicit generic parameter of its function)
function collectVars(type: Type | undefined, into: Set<number>): void {
  switch (type?.kind) {
    case 'variable':
      into.add(type.id)
      break
    case 'array':
      collectVars(type.element, into)
      break
    case 'map':
      collectVars(type.key, into)
      collectVars(type.value, into)
      break
    case 'function':
      type.params.forEach(p => collectVars(p, into))
      collectVars(type.result, into)
      break
    case 'named':
      type.args?.forEach(a => collectVars(a, into))
      break
    default:
      break
  }
}

const OP: Record<string, string> = {
  '&&': '&&',
  '||': '||',
  '==': '==',
  '!=': '!=',
  '<': '<',
  '<=': '<=',
  '>': '>',
  '>=': '>=',
  '+': '+',
  '-': '-',
  '*': '*',
  '/': '/',
  '%': '%',
}

export function emitRust(program: Program): string {
  const pad = (d: number) => '    '.repeat(d)
  const variantOwner = new Map<string, string>()
  // a variant's field names, for binding them in a `match` arm (`Maybe::Some { value } => ...`) so the branch body can
  // read them; a `subject/field` read inside the branch then resolves to that bound local.
  const variantFields = new Map<string, Array<string>>()
  // struct / variant fields that hold a closure (a `Box<dyn Fn>`): calling one needs parentheses (`(r.handle)(x)`),
  // since rust would otherwise read `r.handle(x)` as a method call on a field named `handle`.
  const closureFields = new Set<string>()
  for (const node of program) {
    if (node.form !== 'record-type') continue
    for (const v of node.variants) {
      variantOwner.set(v.name, node.name)
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )
      for (const f of v.fields)
        if (f.type.kind === 'function') closureFields.add(f.name)
    }
    for (const f of node.fields)
      if (f.type.kind === 'function') closureFields.add(f.name)
  }
  // within a match arm, which subject variable is narrowed to which variant (so `subject/field` reads the bound local)
  const narrowing = new Map<string, string>()
  // for each form, which of its generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>`
  // stores `items: hash<t, bool>`, so its index 0 is a key; a method generic that fills that slot needs `Eq + Hash`.
  const formKeyIndices = new Map<string, Set<number>>()
  for (const node of program) {
    if (node.form !== 'record-type' || node.params.length === 0)
      continue
    const keyParams = new Set<string>()
    const findKeys = (t: Type | undefined): void => {
      if (!t) return
      if (t.kind === 'map') {
        if (t.key.kind === 'named') keyParams.add(t.key.name)
        findKeys(t.key)
        findKeys(t.value)
      } else if (t.kind === 'array') findKeys(t.element)
      else if (t.kind === 'named') t.args?.forEach(findKeys)
    }
    const fields =
      node.variants.length > 0
        ? node.variants.flatMap(v => v.fields)
        : node.fields
    fields.forEach(f => findKeys(f.type))
    const indices = new Set<number>()
    node.params.forEach((p, i) => {
      if (keyParams.has(p)) indices.add(i)
    })
    if (indices.size > 0) formKeyIndices.set(node.name, indices)
  }
  // native dock aliases: `fs/read-to-string` is a module path (`fs::read_to_string`), but `r/body` (r a value) is a
  // field access (`r.body`). Only a member chain rooted at a dock alias uses `::`; everything else uses `.`.
  const aliases = new Set<string>()
  for (const node of program)
    if (node.form === 'native') aliases.add(node.alias)
  const rootVariable = (node: Expression): string | undefined =>
    node.form === 'variable'
      ? node.name
      : node.form === 'member'
        ? rootVariable(node.target)
        : undefined

  const expr = (node: Expression): string => {
    switch (node.form) {
      case 'integer':
        return String(node.value)
      case 'float':
        // a float literal must carry a decimal point so the value and its arithmetic are f64, not integer
        return Number.isInteger(node.value)
          ? `${node.value}.0`
          : String(node.value)
      case 'boolean':
        return node.value ? 'true' : 'false'
      case 'string':
        return `${JSON.stringify(node.value)}.to_string()`
      case 'unit':
        return '()'
      case 'variable':
      case 'hole':
        return vname(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary':
        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`
      case 'call': {
        // a native map / list operation lowers to rust's collection API through the Rc<RefCell> handle
        const operation = collectionCall(node.callee)
        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // Rust moves a value passed by value, so a local (or a field read out of a struct) used as an argument would
        // move it away. Cloning a non-function variable / field argument is transparent here -- every collection is an
        // `Rc` (a cheap shared handle), every struct derives `Clone`, scalars are `Copy` -- and frees callers from
        // manual ownership juggling. A closure is function-typed (`Box<dyn Fn>`, not `Clone`), so it passes unchanged.
        const args = node.args
          .map(a =>
            (a.form === 'variable' || a.form === 'member') &&
            a.type &&
            a.type.kind !== 'function'
              ? `${expr(a)}.clone()`
              : expr(a),
          )
          .join(', ')
        // a slashed callee (`fs/read-to-string`) is a module path: emit Rust `::` segments. A field holding a closure
        // is invoked with parens (`(r.handle)(x)`), distinguishing it from a method call.
        if (node.callee.form === 'member') {
          const callee = memberPath(node.callee)
          return closureFields.has(node.callee.name)
            ? `(${callee})(${args})`
            : `${callee}(${args})`
        }
        return `${expr(node.callee)}(${args})`
      }
      case 'array':
        return `vec![${node.items.map(expr).join(', ')}]`
      case 'record': {
        const owner = variantOwner.get(node.name)
        if (owner) {
          const fields = node.fields.map(
            f => `${snake(f.name)}: ${expr(f.value)}`,
          )
          return fields.length > 0
            ? `${pascal(owner)}::${pascal(node.name)} { ${fields.join(
                ', ',
              )} }`
            : `${pascal(owner)}::${pascal(node.name)}`
        }
        return `${pascal(node.name)} { ${node.fields
          .map(f => `${snake(f.name)}: ${expr(f.value)}`)
          .join(', ')} }`
      }
      case 'member': {
        // `map.size` / `array.length` read the length (a map goes through its Rc<RefCell> handle; an array is a plain
        // Vec). Rendered as i64, the seed number type.
        const read = collectionRead(node)
        if (read) {
          const handle =
            read.kind === 'map'
              ? `${expr(read.target)}.borrow()`
              : expr(read.target)
          return `(${handle}.len() as i64)`
        }

        return memberPath(node)
      }
      case 'await':
        return `${expr(node.expr)}.await`
      case 'map':
        return `std::rc::Rc::new(std::cell::RefCell::new(${
          node.entries.length === 0
            ? 'std::collections::HashMap::new()'
            : `std::collections::HashMap::from([${node.entries
                .map(e => `(${expr(e.key)}, ${expr(e.value)})`)
                .join(', ')}])`
        }))`
      case 'closure': {
        // a `move` closure boxed as `Box<dyn Fn>` (owns its captures, so it is `'static` and storable). Reassigned
        // parameters get the same `let mut` shadow functions use, since closure parameters are immutable too.
        const params = node.params.map(p => vname(p.name)).join(', ')
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(p => `let mut ${vname(p.name)} = ${vname(p.name)};`)
        const body = [...shadows, ...node.body.map(s => stmt(s, 0))]
          .filter(Boolean)
          .join(' ')
        return `Box::new(move |${params}| { ${body} })`
      }
      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to rust, going through the Rc<RefCell> handle (`.borrow()` / `.borrow_mut()`).
  // The return shapes match the JS collection API the stdlib forms expect: `set` yields the map (an Rc clone), `delete`
  // / `push` yield a boolean / the new length, `keys` / `values` materialize a new `Vec`, sizes are i64.
  const collectionExpr = (
    op: CollectionOp,
    args: Array<Expression>,
  ): string => {
    const target = expr(op.target)
    const arg = args.map(expr)
    if (op.kind === 'map') {
      switch (op.op) {
        case 'has':
          return `${target}.borrow().contains_key(&${arg[0]})`
        case 'get':
          return `${target}.borrow().get(&${arg[0]}).cloned().unwrap()`
        case 'set':
          return `{ ${target}.borrow_mut().insert(${arg[0]}, ${arg[1]}); ${target}.clone() }`
        case 'delete':
          return `${target}.borrow_mut().remove(&${arg[0]}).is_some()`
        case 'keys':
          return `${target}.borrow().keys().cloned().collect::<Vec<_>>()`
        case 'values':
          return `${target}.borrow().values().cloned().collect::<Vec<_>>()`
        default:
          return ''
      }
    }

    // arrays are plain `Vec` (owned, and locals emit as `let mut`, so in-place mutation works without a shared handle).
    // the closure ops take a `Box<dyn Fn>` and clone each element into it; iterator adapters collect back to a `Vec`.
    switch (op.op) {
      case 'push':
        return `{ ${target}.push(${arg[0]}); ${target}.len() as i64 }`
      case 'pop':
        return `${target}.pop().unwrap()`
      case 'at':
        return `${target}[(${arg[0]}) as usize].clone()`
      case 'includes':
        return `${target}.contains(&${arg[0]})`
      case 'indexOf':
        return `${target}.iter().position(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
      case 'concat':
        return `[${target}, ${arg[0]}].concat()`
      case 'slice':
        // one argument slices to the end (JS `slice(start)`); two slices a range
        return arg[1] !== undefined
          ? `${target}[(${arg[0]} as usize)..(${arg[1]} as usize)].to_vec()`
          : `${target}[(${arg[0]} as usize)..].to_vec()`
      case 'toReversed':
        return `${target}.iter().rev().cloned().collect::<Vec<_>>()`
      case 'join':
        return `${target}.iter().map(|e| format!("{}", e)).collect::<Vec<_>>().join(&${arg[0]})`
      case 'map':
        return `${target}.iter().map(|e| ${arg[0]}(e.clone())).collect::<Vec<_>>()`
      case 'filter':
        return `${target}.iter().filter(|e| ${arg[0]}((*e).clone())).cloned().collect::<Vec<_>>()`
      case 'some':
        return `${target}.iter().any(|e| ${arg[0]}(e.clone()))`
      case 'every':
        return `${target}.iter().all(|e| ${arg[0]}(e.clone()))`
      case 'reduce':
        return `${target}.iter().fold(${arg[1]}, |acc, e| ${arg[0]}(acc, e.clone()))`
      case 'findIndex':
        return `${target}.iter().position(|e| ${arg[0]}(e.clone())).map(|i| i as i64).unwrap_or(-1)`
      case 'flat':
        // flatten is only defined for a list of lists; it cannot be typed over an arbitrary element, so it panics here
        return `unimplemented!("flatten is only defined for a list of lists")`
      default:
        return ''
    }
  }

  // a member chain. A native module alias path (`fs/read-to-string`) is a Rust `::` path; a value field access is `.`
  const memberPath = (node: Expression): string => {
    if (node.form === 'member') {
      // a `subject/field` read inside a match arm that narrowed `subject` to a variant resolves to the bound local
      if (node.target.form === 'variable') {
        const variant = narrowing.get(node.target.name)
        if (
          variant &&
          variantFields.get(variant)?.includes(node.name)
        ) {
          return snake(node.name)
        }
      }

      const root = rootVariable(node)
      const separator = root && aliases.has(root) ? '::' : '.'
      return `${memberPath(node.target)}${separator}${snake(node.name)}`
    }
    return expr(node)
  }

  const block = (body: Array<Statement>, d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let':
        return `let mut ${vname(node.name)} = ${expr(node.init)};`
      case 'assign':
        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)};`
          : `${expr(node.target)} ${node.op} ${expr(node.value)};`
      case 'expression':
        return `${expr(node.expr)};`
      case 'return':
        return node.value ? `return ${expr(node.value)};` : 'return;'
      case 'throw':
        return `panic!("{}", ${
          node.value.form === 'string'
            ? expr(node.value)
            : `format!("{:?}", ${expr(node.value)})`
        });`
      case 'while':
        return `while ${expr(node.cond)} {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      case 'for-each':
        return `for ${vname(node.item)} in ${expr(
          node.iterable,
        )} {\n${block(node.body, d + 1)}\n${pad(d)}}`
      case 'match': {
        // match a clone of the subject: a variant pattern binds (moves out) the variant's fields, so matching the
        // original would partially move it and break a branch that also uses the whole subject (`return self`). Our
        // ADTs all derive Clone, so this is always valid; the bound fields come from the clone, the original is intact.
        const subject = `${expr(node.subject)}.clone()`
        const subjectVar =
          node.subject.form === 'variable'
            ? node.subject.name
            : undefined
        const arms = node.cases.map(b => {
          const owner = variantOwner.get(b.label) ?? ''
          const fields = variantFields.get(b.label) ?? []
          // bind the variant's fields so the branch body can read them; narrow the subject for this arm so a
          // `subject/field` read resolves to the bound local (restored after the arm so sibling arms are unaffected)
          const pattern =
            fields.length > 0
              ? ` { ${fields.map(snake).join(', ')} }`
              : ''
          const previous = subjectVar
            ? narrowing.get(subjectVar)
            : undefined
          if (subjectVar) narrowing.set(subjectVar, b.label)
          const body = block(b.body, d + 2)
          if (subjectVar) {
            if (previous === undefined) narrowing.delete(subjectVar)
            else narrowing.set(subjectVar, previous)
          }
          return `${pad(d + 1)}${pascal(owner)}::${pascal(
            b.label,
          )}${pattern} => {\n${body}\n${pad(d + 1)}}`
        })
        if (node.otherwise)
          arms.push(
            `${pad(d + 1)}_ => {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        return `match ${subject} {\n${arms.join('\n')}\n${pad(d)}}`
      }
      case 'if': {
        let out = ''
        node.branches.forEach((b, i) => {
          out += `${i ? ' else ' : ''}if ${expr(b.cond)} {\n${block(
            b.body,
            d + 1,
          )}\n${pad(d)}}`
        })
        if (node.otherwise)
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        return out
      }
      case 'break':
        return 'break;'
      case 'continue':
        return 'continue;'
      case 'function': {
        // a generic parameter appears in a signature two ways: as a declared name (`head t` that survived as a named
        // type) or as a free inference variable. Collect both. Each free variable gets a fresh letter, mapped by id so
        // `rustType` prints the letter not `i64`. Every generic carries `Clone` (the owned-value style clones freely,
        // and every type a generic is instantiated at is Clone; closures are function-typed, never generic). One used
        // as a map KEY additionally needs `Eq + Hash`.
        const ids = new Set<number>()
        node.params.forEach(p => collectVars(p.type, ids))
        collectVars(node.result, ids)
        // a single pass that records which generics (by variable id or by name) sit in a map-KEY position, following
        // form arguments through `formKeyIndices` so a `Set<U>` marks U even though its map is hidden inside the struct
        const keyIds = new Set<number>()
        const keyNames = new Set<string>()
        const markKeys = (
          t: Type | undefined,
          isKey: boolean,
        ): void => {
          if (!t) return
          if (t.kind === 'variable') {
            if (isKey) keyIds.add(t.id)
          } else if (t.kind === 'map') {
            markKeys(t.key, true)
            markKeys(t.value, false)
          } else if (t.kind === 'array') markKeys(t.element, false)
          else if (t.kind === 'function') {
            t.params.forEach(p => markKeys(p, false))
            markKeys(t.result, false)
          } else if (t.kind === 'named') {
            if (isKey) keyNames.add(t.name.toUpperCase())
            const keyArgs = formKeyIndices.get(t.name)
            t.args?.forEach((a, i) =>
              markKeys(a, keyArgs?.has(i) ?? false),
            )
          }
        }
        node.params.forEach(p => markKeys(p.type, false))
        markKeys(node.result, false)
        // which declared generics actually appear in the signature (as named types); drop the rest
        const namedInSig = new Set<string>()
        const scanNamed = (t: Type | undefined): void => {
          if (!t) return
          if (t.kind === 'named') {
            namedInSig.add(t.name.toUpperCase())
            t.args?.forEach(scanNamed)
          } else if (t.kind === 'array') scanNamed(t.element)
          else if (t.kind === 'map') {
            scanNamed(t.key)
            scanNamed(t.value)
          } else if (t.kind === 'function') {
            t.params.forEach(scanNamed)
            scanNamed(t.result)
          }
        }
        node.params.forEach(p => scanNamed(p.type))
        scanNamed(node.result)
        // extra element bounds the body's array ops require: equality (`includes` / `indexOf`), display (`join`)
        const arrayBounds = collectArrayBounds(node.body)
        // a generic's bound: `Clone` always; `Eq + Hash` for a map key (which implies PartialEq); `PartialEq` for an
        // array used with `includes` / `indexOf`; `Display` for one stringified by `join`.
        const bound = (
          name: string,
          isKey: boolean,
          isEq: boolean,
          isDisplay: boolean,
        ): string => {
          const traits = ['Clone']
          if (isKey) traits.push('Eq', 'std::hash::Hash')
          else if (isEq) traits.push('PartialEq')
          if (isDisplay) traits.push('std::fmt::Display')
          return `${name}: ${traits.join(' + ')}`
        }
        const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
        const used = new Set(
          node.generics.map(g => g.name.toUpperCase()),
        )
        rustVarNames = new Map()
        const fresh: Array<string> = []
        for (const id of ids) {
          const letter = pool.find(l => !used.has(l)) ?? `T${id}`
          used.add(letter)
          rustVarNames.set(id, letter)
          fresh.push(
            bound(
              letter,
              keyIds.has(id),
              arrayBounds.eqIds.has(id),
              arrayBounds.displayIds.has(id),
            ),
          )
        }
        const kept = node.generics
          .map(g => g.name.toUpperCase())
          .filter(name => namedInSig.has(name))
          .map(name =>
            bound(
              name,
              keyNames.has(name),
              arrayBounds.eqNames.has(name),
              arrayBounds.displayNames.has(name),
            ),
          )
        const decls = [...kept, ...fresh]
        const generics = decls.length ? `<${decls.join(', ')}>` : ''
        const params = node.params
          .map(p => `${vname(p.name)}: ${rustType(p.type)}`)
          .join(', ')
        const ret =
          node.result && node.result.kind !== 'unit'
            ? ` -> ${rustType(node.result)}`
            : ''
        // reassigned parameters are shadowed by `let mut` (Rust parameters are immutable)
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const shadows = node.params
          .filter(p => mutated.has(p.name))
          .map(
            p =>
              `${pad(d + 1)}let mut ${vname(p.name)} = ${vname(
                p.name,
              )};`,
          )
        const bodyText = [...shadows, block(node.body, d + 1)]
          .filter(Boolean)
          .join('\n')
        const asyncMark = node.async ? 'async ' : ''
        return `${asyncMark}fn ${snake(
          node.name,
        )}${generics}(${params})${ret} {\n${bodyText}\n${pad(d)}}`
      }
      case 'record-type': {
        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''
        // a struct/enum is `Clone` unless it holds a closure (`Box<dyn Fn>` is not Clone). Deriving Clone lets a value
        // be shared at a call site rather than moved -- the same property the Rc-wrapped collections rely on.
        const hasClosureField =
          node.variants.length > 0
            ? node.variants.some(v =>
                v.fields.some(f => f.type.kind === 'function'),
              )
            : node.fields.some(f => f.type.kind === 'function')
        const derive = hasClosureField
          ? ''
          : `#[derive(Clone)]\n${pad(d)}`
        if (node.variants.length > 0) {
          const cases = node.variants.map(v => {
            const fields = v.fields.map(
              f => `${snake(f.name)}: ${rustType(f.type)}`,
            )
            return `${pad(d + 1)}${pascal(v.name)}${
              fields.length > 0 ? ` { ${fields.join(', ')} }` : ''
            }`
          })
          return `${derive}enum ${pascal(
            node.name,
          )}${generics} {\n${cases.join(',\n')}\n${pad(d)}}`
        }
        const fields = node.fields.map(
          f => `${pad(d + 1)}${snake(f.name)}: ${rustType(f.type)}`,
        )
        return `${derive}struct ${pascal(
          node.name,
        )}${generics} {\n${fields.join(',\n')}\n${pad(d)}}`
      }
      case 'hold':
        return '// hold: verified at compile time'
      case 'native':
        return ''
      case 'mask':
      case 'instance':
      case 'zone':
      case 'dock':
        return ''
      default:
        return exhausted(node)
    }
  }

  // `use` declarations for native module bindings (a `<global:X>` binding needs no use)
  const uses = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' && !n.module.startsWith('global:'),
    )
    .map(n => `use ${n.module.replace(/[:/]/g, '::')};`)
  const body = program
    .filter(n => n.form !== 'native')
    .map(n => stmt(n, 0))
    .filter(Boolean)
  return [...uses, ...body].join('\n\n') + '\n'
}

// names reassigned anywhere in a body (a reassigned parameter needs a `let mut` shadow)
function reassigned(body: Array<Statement>, into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'assign':
        if (s.target.form === 'variable') into.add(s.target.name)
        break
      case 'if':
        s.branches.forEach(b => reassigned(b.body, into))
        if (s.otherwise) reassigned(s.otherwise, into)
        break
      case 'match':
        s.cases.forEach(c => reassigned(c.body, into))
        if (s.otherwise) reassigned(s.otherwise, into)
        break
      case 'while':
      case 'for-each':
        reassigned(s.body, into)
        break
      default:
        break
    }
  }
}

// the extra element-type bounds a function body needs from its array ops: equality (`includes` / `indexOf`) or display
// (`join`). Returns the generic variable ids and names sitting at the element position of an array receiving such an op.
function collectArrayBounds(body: Array<Statement>): {
  eqIds: Set<number>
  displayIds: Set<number>
  eqNames: Set<string>
  displayNames: Set<string>
} {
  const eqIds = new Set<number>()
  const displayIds = new Set<number>()
  const eqNames = new Set<string>()
  const displayNames = new Set<string>()
  const record = (callee: Expression): void => {
    const op = collectionCall(callee)
    if (!op || op.kind !== 'array') return

    const need = ARRAY_OP_BOUND[op.op]
    if (!need) return

    const element =
      op.target.type?.kind === 'array' ? op.target.type.element : undefined
    if (element?.kind === 'variable')
      (need === 'eq' ? eqIds : displayIds).add(element.id)
    else if (element?.kind === 'named')
      (need === 'eq' ? eqNames : displayNames).add(
        element.name.toUpperCase(),
      )
  }
  const visitExpr = (e: Expression | undefined): void => {
    if (!e) return
    switch (e.form) {
      case 'call':
        record(e.callee)
        visitExpr(e.callee)
        e.args.forEach(visitExpr)
        break
      case 'binary':
        visitExpr(e.left)
        visitExpr(e.right)
        break
      case 'unary':
        visitExpr(e.operand)
        break
      case 'member':
        visitExpr(e.target)
        break
      case 'array':
        e.items.forEach(visitExpr)
        break
      case 'map':
        e.entries.forEach(en => {
          visitExpr(en.key)
          visitExpr(en.value)
        })
        break
      case 'record':
        e.fields.forEach(f => visitExpr(f.value))
        break
      case 'await':
        visitExpr(e.expr)
        break
      case 'closure':
        visitStmts(e.body)
        break
      default:
        break
    }
  }
  const visitStmts = (stmts: Array<Statement>): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          visitExpr(s.init)
          break
        case 'assign':
          visitExpr(s.target)
          visitExpr(s.value)
          break
        case 'expression':
          visitExpr(s.expr)
          break
        case 'return':
          visitExpr(s.value)
          break
        case 'throw':
          visitExpr(s.value)
          break
        case 'hold':
          visitExpr(s.expr)
          break
        case 'while':
          visitExpr(s.cond)
          visitStmts(s.body)
          break
        case 'for-each':
          visitExpr(s.iterable)
          visitStmts(s.body)
          break
        case 'if':
          s.branches.forEach(b => {
            visitExpr(b.cond)
            visitStmts(b.body)
          })
          if (s.otherwise) visitStmts(s.otherwise)
          break
        case 'match':
          visitExpr(s.subject)
          s.cases.forEach(c => visitStmts(c.body))
          if (s.otherwise) visitStmts(s.otherwise)
          break
        default:
          break
      }
    }
  }
  visitStmts(body)
  return { eqIds, displayIds, eqNames, displayNames }
}
