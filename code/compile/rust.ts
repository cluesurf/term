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
  exhausted,
  mapCollect,
  unsupported,
} from '@/code/compile/backend'

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
      return `std::collections::HashMap<${rustType(
        type.key,
      )}, ${rustType(type.value)}>`
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
    case 'variable':
    case 'unknown':
      return 'i64'
    default:
      return 'i64'
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
  // struct / variant fields that hold a closure (a `Box<dyn Fn>`): calling one needs parentheses (`(r.handle)(x)`),
  // since rust would otherwise read `r.handle(x)` as a method call on a field named `handle`.
  const closureFields = new Set<string>()
  for (const node of program) {
    if (node.form !== 'record-type') continue
    for (const v of node.variants) {
      variantOwner.set(v.name, node.name)
      for (const f of v.fields)
        if (f.type.kind === 'function') closureFields.add(f.name)
    }
    for (const f of node.fields)
      if (f.type.kind === 'function') closureFields.add(f.name)
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
        // keys / values on a map materialize an owned `Vec` (a `keys()` iterator yields references, so `.cloned()`)
        const collected = mapCollect(node.callee)
        if (collected) {
          return `${expr(collected.target)}.${collected.name}().cloned().collect::<Vec<_>>()`
        }

        // Rust moves a `String` passed by value, so a local string used as an argument more than once would not
        // compile. Strings are immutable values here, so cloning a bare string-variable argument is semantically
        // transparent and always compiles (String: Clone). This frees callers from manual ownership juggling.
        const args = node.args
          .map(a =>
            a.form === 'variable' && a.type?.kind === 'string'
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
      case 'member':
        return memberPath(node)
      case 'await':
        return `${expr(node.expr)}.await`
      case 'map':
        return node.entries.length === 0
          ? 'std::collections::HashMap::new()'
          : `std::collections::HashMap::from([${node.entries
              .map(e => `(${expr(e.key)}, ${expr(e.value)})`)
              .join(', ')}])`
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

  // a member chain. A native module alias path (`fs/read-to-string`) is a Rust `::` path; a value field access is `.`
  const memberPath = (node: Expression): string => {
    if (node.form === 'member') {
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
        const subject = expr(node.subject)
        const arms = node.cases.map(b => {
          const owner = variantOwner.get(b.label) ?? ''
          return `${pad(d + 1)}${pascal(owner)}::${pascal(
            b.label,
          )} { .. } => {\n${block(b.body, d + 2)}\n${pad(d + 1)}}`
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
        const generics = node.generics.length
          ? `<${node.generics
              .map(g => g.name.toUpperCase())
              .join(', ')}>`
          : ''
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
        if (node.variants.length > 0) {
          const cases = node.variants.map(v => {
            const fields = v.fields.map(
              f => `${snake(f.name)}: ${rustType(f.type)}`,
            )
            return `${pad(d + 1)}${pascal(v.name)}${
              fields.length > 0 ? ` { ${fields.join(', ')} }` : ''
            }`
          })
          return `enum ${pascal(node.name)}${generics} {\n${cases.join(
            ',\n',
          )}\n${pad(d)}}`
        }
        const fields = node.fields.map(
          f => `${pad(d + 1)}${snake(f.name)}: ${rustType(f.type)}`,
        )
        return `struct ${pascal(node.name)}${generics} {\n${fields.join(
          ',\n',
        )}\n${pad(d)}}`
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
