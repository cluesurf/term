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
} from '@term/make/code/compile/node'
import {
  collectBinds,
  renderBind,
  bindGap,
  bindImports,
  referencedBinds,
} from '@term/make/code/compile/bind'
import {
  ARRAY_OP_BOUND,
  collectionCall,
  collectionRead,
  exhausted,
  reassigned,
} from '@term/make/code/compile/backend'
import type { CollectionOp } from '@term/make/code/compile/backend'

// `self` is fine in Rust as a name only in methods; as a free identifier rename it. Names snake_case.
function vname(name: string): string {
  return name === 'self' ? 'slf' : name.replace(/-/g, '_')
}

function snake(name: string): string {
  return name.replace(/-/g, '_')
}

function pascal(name: string): string {
  // strip every hyphen, including one before a digit (`sha-256` -> `Sha256`), so the result is a valid identifier
  return name.replace(/(^|-)([a-z0-9])/g, (_, _d, c: string) =>
    c.toUpperCase(),
  )
}

// a function's free inference variables become named generic parameters; this maps each variable id to its letter for
// the duration of that function's emission, so a generic signature prints `T` / `U` rather than the `i64` default.
let rustVarNames = new Map<number, string>()

// opaque per-backend handle types (`dock type / load <tokio::net::TcpStream>, name tcp-handle`): seed name -> concrete
// rust type. Populated per emit from the program's native `type` declarations, so a `like tcp-handle` field emits the
// real handle type rather than a nonexistent `TcpHandle` struct.
let rustOpaqueTypes = new Map<string, string>()

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
      // like the map: a shared, interior-mutable handle, so a list mutated in place (`push`) through one binding is
      // seen through every binding -- the JS reference semantics the stdlib list relies on.
      return `std::rc::Rc<std::cell::RefCell<Vec<${rustType(
        type.element,
      )}>>>`
    case 'map':
      // a shared, interior-mutable handle, so a map mutated through one binding (a `set.insert`) is seen through every
      // binding even after the owning struct is moved. `Rc` is `Clone`, so passing a map shares it, never moving it.
      return `std::rc::Rc<std::cell::RefCell<std::collections::HashMap<${rustType(
        type.key,
      )}, ${rustType(type.value)}>>>`

    case 'named': {
      const opaque = rustOpaqueTypes.get(type.name)

      if (opaque) {
        return opaque
      }

      return type.args && type.args.length > 0
        ? `${pascal(type.name)}<${type.args.map(rustType).join(', ')}>`
        : pascal(type.name)
    }

    case 'function': {
      // a boxed trait object, not `impl Fn`: this is the one function type that works in every position -- a
      // parameter, a return, a struct field, AND a collection element (`Vec<Box<dyn Fn>>`, `HashMap<_, Box<dyn Fn>>`).
      const params = type.params.map(rustType).join(', ')
      const result = rustType(type.result)

      // an async function value returns a boxed, pinned future (Rust has no async `Fn` sugar): the callable yields
      // `Pin<Box<dyn Future<Output = R>>>`, which the call site `.await`s. Matches the async-closure emission below.
      return type.effects?.includes('async')
        ? `Box<dyn Fn(${params}) -> std::pin::Pin<Box<dyn std::future::Future<Output = ${result}>>>>`
        : `Box<dyn Fn(${params}) -> ${result}>`
    }
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
  // opaque handle types declared by `dock type` shims: seed name -> concrete rust type
  rustOpaqueTypes = new Map(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      .map(n => [n.alias, n.module]),
  )

  const variantOwner = new Map<string, string>()
  // a variant's field names, for binding them in a `match` arm (`Maybe::Some { value } => ...`) so the branch body can
  // read them; a `subject/field` read inside the branch then resolves to that bound local.
  const variantFields = new Map<string, string[]>()
  // struct / variant fields that hold a closure (a `Box<dyn Fn>`): calling one needs parentheses (`(r.handle)(x)`),
  // since rust would otherwise read `r.handle(x)` as a method call on a field named `handle`.
  const closureFields = new Set<string>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantOwner.set(v.name, node.name)
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )

      for (const f of v.fields) {
        if (f.type.kind === 'function') {
          closureFields.add(f.name)
        }
      }
    }

    for (const f of node.fields) {
      if (f.type.kind === 'function') {
        closureFields.add(f.name)
      }
    }
  }

  // traits (masks) emit as native Rust traits, instances as `impl` blocks, and a trait-bounded generic gains a trait
  // bound on its type parameter, so a generic trait-method call lowers to `x.method(..)`. Method signatures are derived
  // from the instance implementations (each desugared to a `<target>_<method>` free function tagged with `method`),
  // with the receiver type replaced by `Self`. See note/seed/compiler/trait-dictionary-passing.md.
  const maskMethods = new Set<string>()

  for (const node of program) {
    if (node.form === 'mask') {
      for (const m of node.methods) {
        maskMethods.add(m)
      }
    }
  }

  // a trait's implementing targets, in program order, so a trait body can borrow one target's signatures
  const instanceTargets = new Map<string, string[]>()

  for (const node of program) {
    if (node.form === 'instance') {
      const list = instanceTargets.get(node.mask) ?? []
      list.push(node.target)
      instanceTargets.set(node.mask, list)
    }
  }

  // the free function implementing a given form's method (`box` + `measure` -> the `box_measure` function node)
  type Fn = Extract<Statement, { form: 'function' }>
  const implFn = new Map<string, Fn>()

  for (const node of program) {
    if (node.form === 'function' && node.method) {
      implFn.set(`${node.method.form}:${node.method.name}`, node)
    }
  }

  // a named type rendered inside a trait declaration: the receiver type becomes `Self`
  const subSelf = (
    t: Type | undefined,
    target: string,
  ): Type | undefined => {
    if (!t) {
      return t
    }

    if (t.kind === 'named') {
      return t.name === target
        ? { kind: 'named', name: 'Self' }
        : t.args
          ? { ...t, args: t.args.map(a => subSelf(a, target)!) }
          : t
    }

    if (t.kind === 'array') {
      return { kind: 'array', element: subSelf(t.element, target)! }
    }

    if (t.kind === 'map') {
      return {
        kind: 'map',
        key: subSelf(t.key, target)!,
        value: subSelf(t.value, target)!,
      }
    }

    if (t.kind === 'function') {
      return {
        kind: 'function',
        params: t.params.map(p => subSelf(p, target)!),
        result: subSelf(t.result, target)!,
        effects: t.effects,
      }
    }

    return t
  }

  // a trait method declaration (no body): `fn measure(self) -> i64;`, derived from an implementation's signature with
  // the receiver as `self` and the receiver type as `Self`
  const traitMethodDecl = (
    fn: Fn | undefined,
    target: string,
  ): string => {
    if (!fn) {
      return ''
    }

    const rest = fn.params
      .slice(1)
      .map(
        p => `${snake(p.name)}: ${rustType(subSelf(p.type, target))}`,
      )

    const ret = fn.result
      ? ` -> ${rustType(subSelf(fn.result, target))}`
      : ''

    return `fn ${snake(fn.method!.name)}(${['self', ...rest].join(
      ', ',
    )})${ret};`
  }

  // an `impl` method that delegates to the free implementation function: `fn measure(self) -> i64 { box_measure(self) }`
  const implMethod = (fn: Fn | undefined, target: string): string => {
    if (!fn) {
      return ''
    }

    const restNames = fn.params.slice(1).map(p => snake(p.name))
    const rest = fn.params
      .slice(1)
      .map(
        p => `${snake(p.name)}: ${rustType(subSelf(p.type, target))}`,
      )

    const ret = fn.result
      ? ` -> ${rustType(subSelf(fn.result, target))}`
      : ''

    const callArgs = ['self', ...restNames].join(', ')

    return `fn ${snake(fn.method!.name)}(${['self', ...rest].join(
      ', ',
    )})${ret} { return ${snake(fn.name)}(${callArgs}); }`
  }

  // within a match arm, which subject variable is narrowed to which variant (so `subject/field` reads the bound local)
  const narrowing = new Map<string, string>()

  // true while emitting the body of a function whose return type is a list: a native dock call returned directly (the
  // shim hands back a plain `Vec`) is wrapped in the seed list's Rc<RefCell> handle to match the declared return type
  let fnReturnsArray = false

  // MOVE ON LAST USE (the Perceus / linearity insight, realized in Rust). The owned-value style clones every variable
  // argument so a later use is never moved away. But a variable read EXACTLY ONCE in the whole function -- and not
  // inside a loop or a nested closure (where the single read re-executes) -- can be MOVED at that use instead of cloned:
  // there is no later use to invalidate, so the Rust borrow checker always accepts it. This eliminates the clone (a deep
  // copy for `String`, a refcount bump for an `Rc` collection) in the common single-use case. It is conservative: when
  // in any doubt the value is still cloned, so the output always compiles. Recomputed per function body.
  let moveArgs = new Set<string>()

  // MUTABLE CAPTURES. A closure is a `Box<dyn Fn>`, which cannot mutate captured state, so a variable ASSIGNED inside
  // a closure body is boxed in `Rc<RefCell<T>>` instead: the declaration wraps the value, every read borrows and
  // clones, every assignment writes through `borrow_mut`, and each capturing closure clones the handle before the
  // `move` (so the original stays usable after the closure is built). This is the same interior-mutability currency
  // the collections already use, applied to a scalar/struct local. Recomputed per function body.
  let cellVars = new Set<string>()

  const isNativeCall = (node: Expression): boolean => {
    if (node.form !== 'call' || node.callee.form !== 'member') {
      return false
    }

    const root = rootVariable(node.callee)

    return root !== undefined && aliases.has(root)
  }

  // for each form, which of its generic parameters (by index) flow into a map KEY position inside its fields. A `set<t>`
  // stores `items: hash<t, bool>`, so its index 0 is a key; a method generic that fills that slot needs `Eq + Hash`.
  const formKeyIndices = new Map<string, Set<number>>()

  for (const node of program) {
    if (node.form !== 'record-type' || node.params.length === 0) {
      continue
    }

    const keyParams = new Set<string>()

    const findKeys = (t: Type | undefined): void => {
      if (!t) {
        return
      }

      if (t.kind === 'map') {
        if (t.key.kind === 'named') {
          keyParams.add(t.key.name)
        }

        findKeys(t.key)
        findKeys(t.value)
      } else if (t.kind === 'array') {
        findKeys(t.element)
      } else if (t.kind === 'named') {
        t.args?.forEach(findKeys)
      }
    }

    const fields =
      node.variants.length > 0
        ? node.variants.flatMap(v => v.fields)
        : node.fields

    fields.forEach(f => findKeys(f.type))

    const indices = new Set<number>()
    node.params.forEach((p, i) => {
      if (keyParams.has(p)) {
        indices.add(i)
      }
    })

    if (indices.size > 0) {
      formKeyIndices.set(node.name, indices)
    }
  }

  // native dock aliases: `fs/read-to-string` is a module path (`fs::read_to_string`), but `r/body` (r a value) is a
  // field access (`r.body`). Only a member chain rooted at a dock alias uses `::`; everything else uses `.`.
  const aliases = new Set<string>()

  for (const node of program) {
    if (node.form === 'native') {
      aliases.add(node.alias)
    }
  }

  // declarative native bindings render their `case rust` template at call sites
  const binds = collectBinds(program)
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
      case 'null':
        // null lives in the dynamic currency, which is `serde_json::Value` on rust
        return 'serde_json::Value::Null'
      case 'variable':
      case 'hole':
        // a mutated capture lives in an Rc<RefCell> handle: a read borrows and clones the value out
        return cellVars.has(node.name)
          ? `${vname(node.name)}.borrow().clone()`
          : vname(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary':
        // string concatenation: Rust's `+` requires `String + &str`, so two owned `String`s (e.g. function-call
        // results) would not compile. `format!` concatenates any Display operands uniformly, owned or borrowed.
        if (
          node.op === '+' &&
          (node.left.type?.kind === 'string' ||
            node.right.type?.kind === 'string' ||
            node.type?.kind === 'string')
        ) {
          return `format!("{}{}", ${expr(node.left)}, ${expr(node.right)})`
        }

        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`

      case 'call': {
        // a declarative native binding renders its `case rust` template, with `$param` placeholders filled by the
        // emitted (un-cloned) arguments: the template author writes the exact native call shape
        if (
          node.callee.form === 'variable' &&
          binds.has(node.callee.name)
        ) {
          const bind = binds.get(node.callee.name)!

          return (
            renderBind(bind, 'rust', node.args.map(expr)) ??
            bindGap(bind.name)
          )
        }

        // a native map / list operation lowers to rust's collection API through the Rc<RefCell> handle
        const operation = collectionCall(node.callee)

        if (operation) {
          return collectionExpr(operation, node.args)
        }

        // Rust moves a value passed by value, so a local (or a field read out of a struct) used as an argument would
        // move it away. Cloning a non-function variable / field argument is transparent here -- every collection is an
        // `Rc` (a cheap shared handle), every struct derives `Clone`, scalars are `Copy` -- and frees callers from
        // manual ownership juggling. A closure is function-typed (`Box<dyn Fn>`, not `Clone`), so it passes unchanged.
        // MOVE ON LAST USE: a bare variable read exactly once in the function (and not in a loop or closure) is moved at
        // this use instead of cloned -- there is no later use to invalidate, so the borrow checker accepts it, and the
        // clone (a deep `String` copy or an `Rc` refcount bump) is saved.
        const argList = node.args.map(a => {
          if (
            a.form === 'variable' &&
            a.type &&
            a.type.kind !== 'function' &&
            moveArgs.has(a.name)
          ) {
            return expr(a)
          }

          // a mutated capture's read already clones the value out of its cell; no second clone
          if (a.form === 'variable' && cellVars.has(a.name)) {
            return expr(a)
          }

          return (a.form === 'variable' || a.form === 'member') &&
            a.type &&
            a.type.kind !== 'function'
            ? `${expr(a)}.clone()`
            : expr(a)
        })

        const args = argList.join(', ')

        // a generic trait-method call (`call measure / read x`, x a trait-bounded generic) lowers to a Rust method call
        // through the trait bound: `(x).measure(..)`. The receiver is the first argument; concrete trait calls were
        // already resolved to the free implementation function by the checker, so a bare trait-method name here is the
        // generic case.
        if (
          node.callee.form === 'variable' &&
          maskMethods.has(node.callee.name) &&
          argList.length >= 1
        ) {
          return `(${argList[0]}).${snake(node.callee.name)}(${argList
            .slice(1)
            .join(', ')})`
        }

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
        return `std::rc::Rc::new(std::cell::RefCell::new(vec![${node.items
          .map(expr)
          .join(', ')}]))`

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
        // a DYNAMIC segment (`read table/{key}`) indexes the collection through its handle
        if (node.index) {
          return `${expr(node.target)}.borrow()[${expr(node.index)} as usize]`
        }

        // `map.size` / `array.length` read the length (a map goes through its Rc<RefCell> handle; an array is a plain
        // Vec). Rendered as i64, the seed number type.
        const read = collectionRead(node)

        if (read) {
          // both a map and an array read their length through the Rc<RefCell> handle
          return `(${expr(read.target)}.borrow().len() as i64)`
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
        // parameters get the same `let mut` shadow functions use, since closure parameters are immutable too. A
        // reassigned name that is a MUTATED CAPTURE keeps its Rc<RefCell> handle instead (no `let mut` shadow).
        const params = node.params.map(p => vname(p.name)).join(', ')
        const mutated = new Set<string>()
        reassigned(node.body, mutated)

        const shadows = node.params
          .filter(p => mutated.has(p.name) && !cellVars.has(p.name))
          .map(p => `let mut ${vname(p.name)} = ${vname(p.name)};`)

        // a closure parameter SHADOWS a same-named cell handle: inside this body the name is the parameter
        const previousCells = cellVars

        if (node.params.some(p => cellVars.has(p.name))) {
          cellVars = new Set(cellVars)
          node.params.forEach(p => cellVars.delete(p.name))
        }

        // inside a closure body, the move-on-last-use set of the enclosing function does not apply (a captured variable
        // cannot be moved out of an `Fn`, and a shadowing closure-local of the same name has different liveness), so
        // clone everything here -- the conservative, always-correct choice.
        const outerMoveArgs = moveArgs
        moveArgs = new Set<string>()
        const body = [...shadows, ...node.body.map(s => stmt(s, 0))]
          .filter(Boolean)
          .join(' ')
        moveArgs = outerMoveArgs

        // each captured cell handle is cloned BEFORE the `move`, so the closure owns its own Rc and the original
        // handle stays usable after the closure is built (mutations flow both ways through the shared cell)
        const used = new Set<string>()
        usedNames(node.body, used)

        const handleClones = [...cellVars]
          .filter(name => used.has(name))
          .map(name => `let ${vname(name)} = ${vname(name)}.clone();`)
          .join(' ')

        cellVars = previousCells

        // an async closure becomes a plain `Fn` whose body is a pinned async block: calling it returns a future the
        // caller `.await`s (Rust closures can't themselves be `async`). The `let`/parameter type annotation supplies
        // the `Pin<Box<dyn Future>>` return so the concrete async block coerces to the boxed trait object.
        const boxed = node.async
          ? `Box::new(move |${params}| std::boxed::Box::pin(async move { ${body} }))`
          : `Box::new(move |${params}| { ${body} })`

        return handleClones ? `{ ${handleClones} ${boxed} }` : boxed
      }

      case 'conditional': {
        // a value-position conditional lowers to an if / else-if / else expression chain
        const tail = node.otherwise ? expr(node.otherwise) : '()'

        return node.branches.reduceRight(
          (rest, branch) =>
            `if ${expr(branch.cond)} { ${expr(branch.value)} } else { ${rest} }`,
          tail,
        )
      }

      default:
        return exhausted(node)
    }
  }

  // lower a native map / list operation to rust, going through the Rc<RefCell> handle (`.borrow()` / `.borrow_mut()`).
  // The return shapes match the JS collection API the stdlib forms expect: `set` yields the map (an Rc clone), `delete`
  // / `push` yield a boolean / the new length, `keys` / `values` / list-returning ops materialize a new handle, i64 sizes.
  const wrapList = (vec: string): string =>
    `std::rc::Rc::new(std::cell::RefCell::new(${vec}))`

  const collectionExpr = (
    op: CollectionOp,
    args: Expression[],
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
          return wrapList(
            `${target}.borrow().keys().cloned().collect::<Vec<_>>()`,
          )
        case 'values':
          return wrapList(
            `${target}.borrow().values().cloned().collect::<Vec<_>>()`,
          )
        default:
          return ''
      }
    }

    // arrays go through the Rc<RefCell<Vec>> handle. The closure ops take a `Box<dyn Fn>` and clone each element into
    // it; an op returning a list materializes a new handle (`wrapList`); the in-place ops use `borrow_mut`.
    const data = `${target}.borrow()`

    switch (op.op) {
      case 'push':
        return `{ ${target}.borrow_mut().push(${arg[0]}); ${data}.len() as i64 }`
      case 'pop':
        return `${target}.borrow_mut().pop().unwrap()`
      case 'at':
        return `${data}[(${arg[0]}) as usize].clone()`
      case 'includes':
        return `${data}.contains(&${arg[0]})`
      case 'indexOf':
        return `${data}.iter().position(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
      case 'concat':
        return wrapList(
          `[${data}.clone(), ${arg[0]}.borrow().clone()].concat()`,
        )
      case 'slice':
        // one argument slices to the end (JS `slice(start)`); two slices a range
        return wrapList(
          arg[1] !== undefined
            ? `${data}[(${arg[0]} as usize)..(${arg[1]} as usize)].to_vec()`
            : `${data}[(${arg[0]} as usize)..].to_vec()`,
        )
      case 'toReversed':
        return wrapList(
          `${data}.iter().rev().cloned().collect::<Vec<_>>()`,
        )
      case 'join':
        return `${data}.iter().map(|e| format!("{}", e)).collect::<Vec<_>>().join(&${arg[0]})`
      case 'map':
        return wrapList(
          `${data}.iter().map(|e| ${arg[0]}(e.clone())).collect::<Vec<_>>()`,
        )
      case 'filter':
        return wrapList(
          `${data}.iter().filter(|e| ${arg[0]}((*e).clone())).cloned().collect::<Vec<_>>()`,
        )
      case 'some':
        return `${data}.iter().any(|e| ${arg[0]}(e.clone()))`
      case 'every':
        return `${data}.iter().all(|e| ${arg[0]}(e.clone()))`
      case 'reduce':
        return `${data}.iter().fold(${arg[1]}, |acc, e| ${arg[0]}(acc, e.clone()))`
      case 'findIndex':
        return `${data}.iter().position(|e| ${arg[0]}(e.clone())).map(|i| i as i64).unwrap_or(-1)`
      case 'flat':
        // flattening a non-nested list is a shallow copy (JS `[1,2,3].flat()` is `[1,2,3]`)
        return wrapList(`${data}.clone()`)
      case 'unshift':
        // insert at the front, returning the new length (JS `unshift`)
        return `{ let mut __b = ${target}.borrow_mut(); __b.insert(0, ${arg[0]}); __b.len() as i64 }`
      case 'shift':
        // remove and return the front element (JS `shift`); callers guard against empty
        return `${target}.borrow_mut().remove(0)`

      case 'splice': {
        // JS `splice(start, deleteCount, ...items)`: remove `deleteCount` at `start`, insert the items, in place
        const items = arg.slice(2).join(', ')

        return `{ let mut __b = ${target}.borrow_mut(); let __s = (${arg[0]}) as usize; let __d = (${arg[1]}) as usize; let _: Vec<_> = __b.splice(__s..__s + __d, vec![${items}]).collect(); 0i64 }`
      }

      default:
        return ''
    }
  }

  // the assignment-target text when the target is (rooted at) a mutated capture: the bare variable writes through
  // `*x.borrow_mut()`, a plain field chain through `x.borrow_mut().field`. Undefined when the target is not cell-boxed
  // (or is an indexed segment, which keeps the default rendering).
  const cellAssignTarget = (target: Expression): string | undefined => {
    if (target.form === 'variable' && cellVars.has(target.name)) {
      return `*${vname(target.name)}.borrow_mut()`
    }

    if (target.form === 'member') {
      const fields: string[] = []
      let node: Expression = target

      while (node.form === 'member' && !node.index) {
        fields.unshift(snake(node.name))
        node = node.target
      }

      if (
        node.form === 'variable' &&
        cellVars.has(node.name) &&
        fields.length > 0
      ) {
        return `${vname(node.name)}.borrow_mut().${fields.join('.')}`
      }
    }

    return undefined
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

  const block = (body: Statement[], d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        // a MUTATED CAPTURE is declared as its Rc<RefCell> handle (reads / writes go through the cell)
        if (cellVars.has(node.name)) {
          return `let ${vname(
            node.name,
          )} = std::rc::Rc::new(std::cell::RefCell::new(${expr(
            node.init,
          )}));`
        }

        // an async closure stored in a local needs its boxed-future type spelled out, so the concrete async block
        // coerces to `Box<dyn Fn(..) -> Pin<Box<dyn Future>>>` and the parameter types are pinned down.
        const ann =
          node.init.form === 'closure' && node.init.async
            ? `: ${rustType({
                kind: 'function',
                params: node.init.params.map(
                  (p): Type => p.type ?? { kind: 'unknown' },
                ),
                result: node.init.result ?? { kind: 'unknown' },
                effects: ['async'],
              })}`
            : ''

        return `let mut ${vname(node.name)}${ann} = ${expr(node.init)};`
      }
      case 'assign': {
        // an assignment to a mutated capture writes through the cell: `*x.borrow_mut() = v`, and a field of a
        // cell-boxed struct writes through the borrowed root: `x.borrow_mut().field = v`. The value computes into a
        // temporary FIRST: a `x.borrow()` inside it is a temporary `Ref` guard that lives to the end of its whole
        // statement, so evaluating it in the same statement as the `borrow_mut` would panic at run time
        // (`RefCell already borrowed`). The inner `let` scopes that guard to its own statement.
        const cellTarget = cellAssignTarget(node.target)

        if (cellTarget) {
          return `{ let __cell_value = ${expr(
            node.value,
          )}; ${cellTarget} ${node.op} __cell_value; }`
        }

        return node.op === '='
          ? `${expr(node.target)} = ${expr(node.value)};`
          : `${expr(node.target)} ${node.op} ${expr(node.value)};`
      }
      case 'expression':
        return `${expr(node.expr)};`
      case 'return':
        if (!node.value) {
          return 'return;'
        }

        // a list-returning function that returns a native dock call directly wraps the shim's plain `Vec`
        return fnReturnsArray && isNativeCall(node.value)
          ? `return ${wrapList(expr(node.value))};`
          : `return ${expr(node.value)};`
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
      case 'guard':
        // a raise is a panic on this backend today, so a guard catches nothing yet: the body runs as written and the
        // handler is dropped. The Result lowering of note/term/hive/04-reach.md replaces this.
        return `{\n${block(node.body, d + 1)}\n${pad(d)}}`

      case 'for-each': {
        // a list is an Rc<RefCell<Vec>>; iterate an owned clone of its elements so the loop binds `T`, not `&T`, and
        // does not hold a borrow across the body
        const iterable =
          node.iterable.type?.kind === 'array'
            ? `${expr(node.iterable)}.borrow().clone()`
            : expr(node.iterable)

        return `for ${vname(node.item)} in ${iterable} {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      }

      case 'match': {
        // a match whose labels are only true/false is a match over a NATIVE bool (booleans lower to `bool` here, not
        // an ADT), so the arms are the literal patterns `true` / `false`, not enum variants. Rust's bool match with
        // both literal arms is exhaustive; an `otherwise` becomes the wildcard arm.
        const labels = node.cases.map(branch => branch.label)
        const booleans =
          labels.length > 0 &&
          labels.every(label => label === 'true' || label === 'false')

        if (booleans) {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${b.label} => {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          // a single-literal match needs the wildcard arm to be exhaustive, even without an `otherwise`
          if (node.otherwise) {
            arms.push(
              `${pad(d + 1)}_ => {\n${block(
                node.otherwise,
                d + 2,
              )}\n${pad(d + 1)}}`,
            )
          } else if (node.cases.length < 2) {
            arms.push(`${pad(d + 1)}_ => {}`)
          }

          return `match ${expr(node.subject)} {\n${arms.join(
            '\n',
          )}\n${pad(d)}}`
        }

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

          if (subjectVar) {
            narrowing.set(subjectVar, b.label)
          }

          const body = block(b.body, d + 2)

          if (subjectVar) {
            if (previous === undefined) {
              narrowing.delete(subjectVar)
            } else {
              narrowing.set(subjectVar, previous)
            }
          }

          return `${pad(d + 1)}${pascal(owner)}::${pascal(
            b.label,
          )}${pattern} => {\n${body}\n${pad(d + 1)}}`
        })

        if (node.otherwise) {
          arms.push(
            `${pad(d + 1)}_ => {\n${block(
              node.otherwise,
              d + 2,
            )}\n${pad(d + 1)}}`,
          )
        }

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

        if (node.otherwise) {
          out += ` else {\n${block(node.otherwise, d + 1)}\n${pad(d)}}`
        }

        return out
      }

      case 'break':
        return 'break;'
      case 'continue':
        return 'continue;'
      case 'exit':
        return 'std::process::exit(0);'
      case 'debug':
        return '// breakpoint'

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
          if (!t) {
            return
          }

          if (t.kind === 'variable') {
            if (isKey) {
              keyIds.add(t.id)
            }
          } else if (t.kind === 'map') {
            markKeys(t.key, true)
            markKeys(t.value, false)
          } else if (t.kind === 'array') {
            markKeys(t.element, false)
          } else if (t.kind === 'function') {
            t.params.forEach(p => markKeys(p, false))
            markKeys(t.result, false)
          } else if (t.kind === 'named') {
            if (isKey) {
              keyNames.add(t.name.toUpperCase())
            }

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
          if (!t) {
            return
          }

          if (t.kind === 'named') {
            namedInSig.add(t.name.toUpperCase())
            t.args?.forEach(scanNamed)
          } else if (t.kind === 'array') {
            scanNamed(t.element)
          } else if (t.kind === 'map') {
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

          if (isKey) {
            traits.push('Eq', 'std::hash::Hash')
          } else if (isEq) {
            traits.push('PartialEq')
          }

          if (isDisplay) {
            traits.push('std::fmt::Display')
          }

          return `${name}: ${traits.join(' + ')}`
        }

        const pool = ['T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'A', 'B', 'C']
        const used = new Set(
          node.generics.map(g => g.name.toUpperCase()),
        )

        rustVarNames = new Map()

        const fresh: string[] = []

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

        // a trait-bounded generic (`head t, need sizer`) adds its trait to the bound, so the body's `x.measure()`
        // resolves through it. Keyed by uppercase generic name to match `kept`.
        const needTrait = new Map<string, string>()

        for (const g of node.generics) {
          if (g.need) {
            needTrait.set(g.name.toUpperCase(), pascal(g.need))
          }
        }

        const kept = node.generics
          .map(g => g.name.toUpperCase())
          .filter(name => namedInSig.has(name))
          .map(name => {
            const base = bound(
              name,
              keyNames.has(name),
              arrayBounds.eqNames.has(name),
              arrayBounds.displayNames.has(name),
            )

            return needTrait.has(name)
              ? `${base} + ${needTrait.get(name)}`
              : base
          })

        const decls = [...kept, ...fresh]
        const generics = decls.length ? `<${decls.join(', ')}>` : ''
        const params = node.params
          .map(p => `${vname(p.name)}: ${rustType(p.type)}`)
          .join(', ')

        const ret =
          node.result && node.result.kind !== 'unit'
            ? ` -> ${rustType(node.result)}`
            : ''

        // names a nested closure ASSIGNS to are boxed in Rc<RefCell> for this whole function body
        const previousCellVars = cellVars
        cellVars = mutatedCaptures(node.body)

        // reassigned parameters are shadowed by `let mut` (Rust parameters are immutable). A parameter that is a
        // MUTATED CAPTURE gets its Rc<RefCell> handle shadow instead.
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        // a parameter mutated in place by a `push` / `pop` is also rebound `let mut` (Rust parameters are immutable)
        arrayBounds.mutated.forEach(name => mutated.add(name))

        const shadows = node.params
          .filter(p => mutated.has(p.name) || cellVars.has(p.name))
          .map(p =>
            cellVars.has(p.name)
              ? `${pad(d + 1)}let ${vname(
                  p.name,
                )} = std::rc::Rc::new(std::cell::RefCell::new(${vname(
                  p.name,
                )}));`
              : `${pad(d + 1)}let mut ${vname(p.name)} = ${vname(
                  p.name,
                )};`,
          )

        const previousReturnsArray = fnReturnsArray
        fnReturnsArray = node.result?.kind === 'array'
        const previousMoveArgs = moveArgs
        moveArgs = moveOnLastUse(node.body)
        // a cell-boxed name is read through its handle on every use; it can never be moved at a use site
        cellVars.forEach(name => moveArgs.delete(name))

        const bodyText = [...shadows, block(node.body, d + 1)]
          .filter(Boolean)
          .join('\n')

        fnReturnsArray = previousReturnsArray
        moveArgs = previousMoveArgs
        cellVars = previousCellVars

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

      case 'mask': {
        // a trait, with each method derived from any implementing instance's signature (receiver type -> Self)
        const target = instanceTargets.get(node.name)?.[0]
        const decls = target
          ? node.methods
              .map(m =>
                traitMethodDecl(implFn.get(`${target}:${m}`), target),
              )
              .filter(Boolean)
          : []

        return `trait ${pascal(node.name)} {${
          decls.length
            ? `\n${decls.map(line => pad(d + 1) + line).join('\n')}\n${pad(d)}`
            : ''
        }}`
      }

      case 'instance': {
        // an `impl` block whose methods delegate to the free implementation functions
        const impls = node.methods
          .map(m =>
            implMethod(implFn.get(`${node.target}:${m}`), node.target),
          )
          .filter(Boolean)

        return `impl ${pascal(node.mask)} for ${pascal(node.target)} {${
          impls.length
            ? `\n${impls.map(line => pad(d + 1) + line).join('\n')}\n${pad(d)}`
            : ''
        }}`
      }

      case 'bind':
      case 'zone':
      case 'dock':
      case 'tell':
        return ''
      default:
        return exhausted(node)
    }
  }

  // `use` declarations for native module bindings (a `<global:X>` binding needs no use; a `type` dock is an inline
  // type reference, not an import)
  const uses = program
    .filter(
      (n): n is Extract<Statement, { form: 'native' }> =>
        n.form === 'native' &&
        n.kind !== 'type' &&
        !n.module.startsWith('global:'),
    )
    .map(n => `use ${n.module.replace(/[:/]/g, '::')};`)

  // plus the `use` each rendered `bind` needs (e.g. `use sha2::Sha256;` for a `case rust` that calls `Sha256::digest`).
  // Two paths that bind the SAME final name collide in Rust (`use sha2::Digest;` + `use md5::Digest;` -> E0252), yet a
  // trait like `Digest` only needs to be in scope for method resolution, not named. So the first occurrence binds the
  // name and any later same-name path comes in anonymously with `as _` (in scope, no name), which is the Rust idiom.
  const bound = new Set<string>()

  for (const u of uses) {
    const m = /use .*?(\w+)(?: as (\w+))?;$/.exec(u)
    const name = m?.[2] ?? m?.[1]

    if (name) {
      bound.add(name)
    }
  }

  for (const need of bindImports(
    referencedBinds(program, binds),
    'rust',
  )) {
    const path = need.module.replace(/[:/]/g, '::')
    const name = need.alias ?? path.split('::').pop()!
    const line = need.alias
      ? `use ${path} as ${need.alias};`
      : bound.has(name)
        ? `use ${path} as _;`
        : `use ${path};`

    bound.add(name)

    if (!uses.includes(line)) {
      uses.push(line)
    }
  }

  const body = program
    .filter(n => n.form !== 'native')
    .map(n => stmt(n, 0))
    .filter(Boolean)

  return [...uses, ...body].join('\n\n') + '\n'
}

// MUTATED-CAPTURE analysis: the names a function must box in `Rc<RefCell>` because a nested closure assigns to them.
// Walks every closure body (any nesting), collecting assignment targets -- a bare variable, or the root variable of a
// member target (`x/field = v` mutates x through the capture too). Names the closure itself declares (`let`) or takes
// as parameters are its own locals, not captures, so they are excluded. Function-typed names are left alone (a stored
// closure is never sensibly reassigned through a capture, and `Box<dyn Fn>` is not `Clone`).
function mutatedCaptures(body: Statement[]): Set<string> {
  const out = new Set<string>()

  // collect assign targets in a CLOSURE body, minus the closure's own locals
  const insideClosure = (
    stmts: Statement[],
    locals: Set<string>,
  ): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          locals.add(s.name)
          exprWalk(s.init, locals, true)
          break
        case 'assign': {
          let target: Expression = s.target

          while (target.form === 'member') {
            target = target.target
          }

          if (
            target.form === 'variable' &&
            !locals.has(target.name) &&
            target.type?.kind !== 'function'
          ) {
            out.add(target.name)
          }

          exprWalk(s.value, locals, true)
          break
        }
        case 'expression':
          exprWalk(s.expr, locals, true)
          break
        case 'return':
          if (s.value) {
            exprWalk(s.value, locals, true)
          }

          break
        case 'throw':
          exprWalk(s.value, locals, true)
          break
        case 'if':
          s.branches.forEach(b => {
            exprWalk(b.cond, locals, true)
            insideClosure(b.body, locals)
          })

          if (s.otherwise) {
            insideClosure(s.otherwise, locals)
          }

          break
        case 'match':
          exprWalk(s.subject, locals, true)
          s.cases.forEach(c => insideClosure(c.body, locals))

          if (s.otherwise) {
            insideClosure(s.otherwise, locals)
          }

          break
        case 'guard':
          insideClosure(s.body, locals)

          if (s.catch) {
            insideClosure(s.catch.body, locals)
          }

          break
        case 'while':
          exprWalk(s.cond, locals, true)
          insideClosure(s.body, locals)
          break
        case 'for-each':
          exprWalk(s.iterable, locals, true)
          insideClosure(s.body, locals)
          break
        default:
          break
      }
    }
  }

  const exprWalk = (
    e: Expression,
    locals: Set<string>,
    inClosure: boolean,
  ): void => {
    switch (e.form) {
      case 'closure': {
        const inner = new Set(inClosure ? locals : [])
        e.params.forEach(p => inner.add(p.name))
        insideClosure(e.body, inner)
        break
      }
      case 'call':
        exprWalk(e.callee, locals, inClosure)
        e.args.forEach(a => exprWalk(a, locals, inClosure))
        break
      case 'binary':
        exprWalk(e.left, locals, inClosure)
        exprWalk(e.right, locals, inClosure)
        break
      case 'unary':
        exprWalk(e.operand, locals, inClosure)
        break
      case 'array':
        e.items.forEach(i => exprWalk(i, locals, inClosure))
        break
      case 'map':
        e.entries.forEach(en => {
          exprWalk(en.key, locals, inClosure)
          exprWalk(en.value, locals, inClosure)
        })
        break
      case 'record':
        e.fields.forEach(f => exprWalk(f.value, locals, inClosure))
        break
      case 'member':
        exprWalk(e.target, locals, inClosure)
        break
      case 'await':
        exprWalk(e.expr, locals, inClosure)
        break
      case 'conditional':
        e.branches.forEach(b => {
          exprWalk(b.cond, locals, inClosure)
          exprWalk(b.value, locals, inClosure)
        })

        if (e.otherwise) {
          exprWalk(e.otherwise, locals, inClosure)
        }

        break
      default:
        break
    }
  }

  const topWalk = (stmts: Statement[]): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          exprWalk(s.init, new Set(), false)
          break
        case 'assign':
          exprWalk(s.target, new Set(), false)
          exprWalk(s.value, new Set(), false)
          break
        case 'expression':
          exprWalk(s.expr, new Set(), false)
          break
        case 'return':
          if (s.value) {
            exprWalk(s.value, new Set(), false)
          }

          break
        case 'throw':
          exprWalk(s.value, new Set(), false)
          break
        case 'if':
          s.branches.forEach(b => {
            exprWalk(b.cond, new Set(), false)
            topWalk(b.body)
          })

          if (s.otherwise) {
            topWalk(s.otherwise)
          }

          break
        case 'match':
          exprWalk(s.subject, new Set(), false)
          s.cases.forEach(c => topWalk(c.body))

          if (s.otherwise) {
            topWalk(s.otherwise)
          }

          break
        case 'guard':
          topWalk(s.body)

          if (s.catch) {
            topWalk(s.catch.body)
          }

          break
        case 'while':
          exprWalk(s.cond, new Set(), false)
          topWalk(s.body)
          break
        case 'for-each':
          exprWalk(s.iterable, new Set(), false)
          topWalk(s.body)
          break
        default:
          break
      }
    }
  }

  topWalk(body)

  return out
}

// every variable name READ or written anywhere in a body (used to decide which Rc<RefCell> handles a closure captures)
function usedNames(body: Statement[], into: Set<string>): void {
  const exprNames = (e: Expression): void => {
    switch (e.form) {
      case 'variable':
      case 'hole':
        into.add(e.name)
        break
      case 'call':
        exprNames(e.callee)
        e.args.forEach(exprNames)
        break
      case 'binary':
        exprNames(e.left)
        exprNames(e.right)
        break
      case 'unary':
        exprNames(e.operand)
        break
      case 'array':
        e.items.forEach(exprNames)
        break
      case 'map':
        e.entries.forEach(en => {
          exprNames(en.key)
          exprNames(en.value)
        })
        break
      case 'record':
        e.fields.forEach(f => exprNames(f.value))
        break
      case 'member':
        exprNames(e.target)
        break
      case 'await':
        exprNames(e.expr)
        break
      case 'closure':
        usedNames(e.body, into)
        break
      case 'conditional':
        e.branches.forEach(b => {
          exprNames(b.cond)
          exprNames(b.value)
        })

        if (e.otherwise) {
          exprNames(e.otherwise)
        }

        break
      default:
        break
    }
  }

  for (const s of body) {
    switch (s.form) {
      case 'let':
        exprNames(s.init)
        break
      case 'assign':
        exprNames(s.target)
        exprNames(s.value)
        break
      case 'expression':
        exprNames(s.expr)
        break
      case 'return':
        if (s.value) {
          exprNames(s.value)
        }

        break
      case 'throw':
        exprNames(s.value)
        break
      case 'if':
        s.branches.forEach(b => {
          exprNames(b.cond)
          usedNames(b.body, into)
        })

        if (s.otherwise) {
          usedNames(s.otherwise, into)
        }

        break
      case 'match':
        exprNames(s.subject)
        s.cases.forEach(c => usedNames(c.body, into))

        if (s.otherwise) {
          usedNames(s.otherwise, into)
        }

        break
      case 'while':
        exprNames(s.cond)
        usedNames(s.body, into)
        break
      case 'for-each':
        exprNames(s.iterable)
        usedNames(s.body, into)
        break
      default:
        break
    }
  }
}

// MOVE-ON-LAST-USE analysis. A variable that is read EXACTLY ONCE across the whole function body, where that single
// read is NOT inside a loop or a nested closure, can be moved at that read instead of cloned (no later use can be
// invalidated, so the borrow checker always accepts the move). Returns the set of such variable names. `reads` counts
// every `variable` occurrence (any nesting); `restricted` counts the ones inside a loop or closure body. A name is
// move-eligible when `reads === 1 && restricted === 0`. Conservative by construction: anything else keeps cloning.
function moveOnLastUse(body: Statement[]): Set<string> {
  const reads = new Map<string, number>()
  const restricted = new Map<string, number>()

  const bump = (name: string, inLoopOrClosure: boolean): void => {
    reads.set(name, (reads.get(name) ?? 0) + 1)

    if (inLoopOrClosure) {
      restricted.set(name, (restricted.get(name) ?? 0) + 1)
    }
  }

  const walkExpr = (node: Expression, restrict: boolean): void => {
    switch (node.form) {
      case 'variable':
        bump(node.name, restrict)
        break
      case 'call':
        walkExpr(node.callee, restrict)
        node.args.forEach(a => walkExpr(a, restrict))
        break
      case 'member':
        walkExpr(node.target, restrict)
        break
      case 'binary':
        walkExpr(node.left, restrict)
        walkExpr(node.right, restrict)
        break
      case 'unary':
        walkExpr(node.operand, restrict)
        break
      case 'await':
        walkExpr(node.expr, restrict)
        break
      case 'array':
        node.items.forEach(i => walkExpr(i, restrict))
        break
      case 'record':
        node.fields.forEach(f => walkExpr(f.value, restrict))
        break
      case 'map':
        node.entries.forEach(e => {
          walkExpr(e.key, restrict)
          walkExpr(e.value, restrict)
        })
        break
      case 'conditional':
        node.branches.forEach(b => {
          walkExpr(b.cond, restrict)
          walkExpr(b.value, restrict)
        })

        if (node.otherwise) {
          walkExpr(node.otherwise, restrict)
        }

        break
      case 'closure':
        // a nested closure body: its reads re-execute on every call (and a captured variable cannot be moved out of a
        // `Fn`), so they are restricted (never move-eligible)
        walkBody(node.body, true)
        break
      default:
        break
    }
  }

  const walkBody = (stmts: Statement[], restrict: boolean): void => {
    for (const s of stmts) {
      switch (s.form) {
        case 'let':
          walkExpr(s.init, restrict)
          break
        case 'assign':
          walkExpr(s.value, restrict)
          walkExpr(s.target, restrict)
          break
        case 'expression':
          walkExpr(s.expr, restrict)
          break
        case 'return':
          if (s.value) {
            walkExpr(s.value, restrict)
          }

          break
        case 'throw':
          walkExpr(s.value, restrict)
          break
        case 'if':
          s.branches.forEach(b => {
            walkExpr(b.cond, restrict)
            walkBody(b.body, restrict)
          })

          if (s.otherwise) {
            walkBody(s.otherwise, restrict)
          }

          break
        case 'guard':
          walkBody(s.body, true)

          if (s.catch) {
            walkBody(s.catch.body, true)
          }

          break
        case 'while':
          walkExpr(s.cond, true)
          walkBody(s.body, true)
          break
        case 'for-each':
          walkExpr(s.iterable, restrict)
          walkBody(s.body, true)
          break
        case 'match':
          walkExpr(s.subject, restrict)
          s.cases.forEach(c => walkBody(c.body, restrict))

          if (s.otherwise) {
            walkBody(s.otherwise, restrict)
          }

          break
        default:
          break
      }
    }
  }

  walkBody(body, false)

  const out = new Set<string>()

  for (const [name, count] of reads) {
    if (count === 1 && (restricted.get(name) ?? 0) === 0) {
      out.add(name)
    }
  }

  return out
}

// the extra element-type bounds a function body needs from its array ops: equality (`includes` / `indexOf`) or display
// (`join`). Returns the generic variable ids and names sitting at the element position of an array receiving such an op.
function collectArrayBounds(body: Statement[]): {
  eqIds: Set<number>
  displayIds: Set<number>
  eqNames: Set<string>
  displayNames: Set<string>
  mutated: Set<string>
} {
  const eqIds = new Set<number>()
  const displayIds = new Set<number>()
  const eqNames = new Set<string>()
  const displayNames = new Set<string>()
  // arrays mutated in place (`push` / `pop`); a parameter so mutated must be rebound `let mut`
  const mutated = new Set<string>()

  const record = (callee: Expression): void => {
    const op = collectionCall(callee)

    if (op?.kind !== 'array') {
      return
    }

    if (
      (op.op === 'push' || op.op === 'pop') &&
      op.target.form === 'variable'
    ) {
      mutated.add(op.target.name)
    }

    const need = ARRAY_OP_BOUND[op.op]

    if (!need) {
      return
    }

    const element =
      op.target.type?.kind === 'array'
        ? op.target.type.element
        : undefined

    if (element?.kind === 'variable') {
      ;(need === 'eq' ? eqIds : displayIds).add(element.id)
    } else if (element?.kind === 'named') {
      ;(need === 'eq' ? eqNames : displayNames).add(
        element.name.toUpperCase(),
      )
    }
  }

  const visitExpr = (e: Expression | undefined): void => {
    if (!e) {
      return
    }

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

  const visitStmts = (stmts: Statement[]): void => {
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
        case 'guard':
          visitStmts(s.body)

          if (s.catch) {
            visitStmts(s.catch.body)
          }

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

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        case 'match':
          visitExpr(s.subject)
          s.cases.forEach(c => visitStmts(c.body))

          if (s.otherwise) {
            visitStmts(s.otherwise)
          }

          break
        default:
          break
      }
    }
  }

  visitStmts(body)

  return { eqIds, displayIds, eqNames, displayNames, mutated }
}
