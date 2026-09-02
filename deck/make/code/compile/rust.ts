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
  stringCall,
  stringRead,
  exhausted,
  reassigned,
  hasValuedReturn,
} from '@term/make/code/compile/backend'
import type { CollectionOp } from '@term/make/code/compile/backend'
import { armLocals } from '@term/make/code/check/arm'
import { raiseSets } from '@term/make/code/check/effects'
import { formSpec, refuseAny, specForms } from '@term/make/code/compile/backend'
import type { FormKind, FormSpec } from '@term/make/code/compile/backend'

// Rust reserved and reserved-for-future-use keywords that cannot be bare identifiers; a seed name colliding with
// one is suffixed with `_`, the same convention typescript.ts's RESERVED already uses, applied uniformly
// (definitions and uses) so a local named e.g. `continue` stays consistent across the module. `self`/`Self` are
// handled separately below (a rename, not a suffix) since `self` is meaningful in a method body.
const RUST_RESERVED = new Set([
  'as', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl',
  'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'static', 'struct', 'super', 'trait',
  'true', 'type', 'unsafe', 'use', 'where', 'while', 'async', 'await', 'abstract', 'become', 'box', 'do', 'final',
  'macro', 'override', 'priv', 'typeof', 'unsized', 'virtual', 'yield', 'try', 'gen',
])

// `self` is fine in Rust as a name only in methods; as a free identifier rename it. Names snake_case.
function vname(name: string): string {
  if (name === 'self') {
    return 'slf'
  }

  const snakeName = name.replace(/-/g, '_')

  return RUST_RESERVED.has(snakeName) ? `${snakeName}_` : snakeName
}

// outer parens around an assigned or returned value are the binary case's grouping: rustc warns on
// them there (unused_parens), so a BALANCED outer pair is stripped
function bare(rendered: string): string {
  if (!rendered.startsWith('(') || !rendered.endsWith(')')) {
    return rendered
  }

  let depth = 0

  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i] === '(') {
      depth += 1
    } else if (rendered[i] === ')') {
      depth -= 1

      if (depth === 0 && i < rendered.length - 1) {
        return rendered
      }
    }
  }

  return rendered.slice(1, -1)
}

function snake(name: string): string {
  const snakeName = name.replace(/-/g, '_')

  // a Term name that is a Rust keyword (`task move`, `task match`, a `move` field) escapes with a trailing
  // underscore, the same way vname does, so every identifier position agrees
  return RUST_RESERVED.has(snakeName) ? `${snakeName}_` : snakeName
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

      if (type.args && type.args.length > 0) {
        return `${pascal(type.name)}<${type.args.map(rustType).join(', ')}>`
      }

      // a generic form named without its arguments (`like maybe`): each parameter is the unknown, i64, the same
      // default a free inference variable gets
      const arity = rustGenericArity.get(type.name) ?? 0

      return arity > 0
        ? `${pascal(type.name)}<${Array.from({ length: arity }, () => 'i64').join(', ')}>`
        : pascal(type.name)
    }

    case 'function': {
      // a shared trait object, not `impl Fn`: this is the one function type that works in every position -- a
      // parameter, a return, a struct field, AND a collection element. `Rc` (not `Box`) so a record holding a
      // closure is still `Clone`, the property every walk over a list of records relies on (the hive's ears).
      const params = type.params.map(rustType).join(', ')
      const result = rustType(type.result)

      // an async function value returns a boxed, pinned future (Rust has no async `Fn` sugar): the callable yields
      // `Pin<Box<dyn Future<Output = R>>>`, which the call site `.await`s. Matches the async-closure emission below.
      return type.effects?.includes('async')
        ? `std::rc::Rc<dyn Fn(${params}) -> std::pin::Pin<Box<dyn std::future::Future<Output = ${result}>>>>`
        : `std::rc::Rc<dyn Fn(${params}) -> ${result}>`
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
      // the declared dynamic (`like unknown` / `like any`): a boxed value of any 'static type, so a hive entry's
      // `base` can carry a record. Construction sites box with `Rc::new` (the unsized coercion fills in `dyn Any`).
      return 'std::rc::Rc<dyn std::any::Any>'
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

// how many type parameters each generic form declares, for a reference that names the form without them
let rustGenericArity = new Map<string, number>()

// the roll grouped by deck, for the generated wake chain (the same shape emitTypeScript takes)
export type WakeGroup = {
  deck: string
  entries: Record<string, unknown>[]
}

export function emitRust(
  program: Program,
  options?: { wake?: WakeGroup[] },
): string {
  const pad = (d: number) => '    '.repeat(d)
  // when the stdlib hive is in the program, every new raise tells it (the throw lowering), and the compiler can
  // emit the wake chain (`wake_hive`) from the roll the driver hands over
  const hasHiveTell = program.some(
    n => n.form === 'function' && n.name === 'hive-tell',
  )
  rustGenericArity = new Map(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type')
      .map(n => [n.name, n.params?.length ?? 0]),
  )
  // opaque handle types declared by `dock type` shims: seed name -> concrete rust type
  rustOpaqueTypes = new Map(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'native' }> =>
          n.form === 'native' && n.kind === 'type',
      )
      // `load <any>` is the portable opaque spelling (a public module's handle with no per-backend type): the
      // boxed dynamic here, `Any` on Swift and Kotlin
      .map(n => [
        n.alias,
        n.module === 'any'
          ? 'std::rc::Rc<dyn std::any::Any>'
          : n.module,
      ]),
  )

  const variantOwner = new Map<string, string>()
  // every enum that declares a variant label (`text` is on both `token` and `data`), so a construction or a match
  // can be steered by the checked type
  const variantOwners = new Map<string, Set<string>>()
  // a variant's field names, for binding them in a `match` arm (`Maybe::Some { value } => ...`) so the branch body can
  // read them; a `subject/field` read inside the branch then resolves to that bound local.
  const variantFields = new Map<string, string[]>()
  // struct / variant fields that hold a closure (a `Box<dyn Fn>`): calling one needs parentheses (`(r.handle)(x)`),
  // since rust would otherwise read `r.handle(x)` as a method call on a field named `handle`.
  const closureFields = new Set<string>()
  // a variant field whose type is the enclosing enum itself (`node.next: linked-list t`): rust refuses the
  // infinitely sized enum, so the field is stored as `Rc<Enum>`, wrapped at construction and unwrapped
  // (cloned out) at the match binding. Keyed `variant/field`.
  const recursiveFields = new Set<string>()

  for (const node of program) {
    if (node.form !== 'record-type') {
      continue
    }

    for (const v of node.variants) {
      variantOwner.set(v.name, node.name)
      variantOwners.set(v.name, (variantOwners.get(v.name) ?? new Set()).add(node.name))
      variantFields.set(
        v.name,
        v.fields.map(f => f.name),
      )

      for (const f of v.fields) {
        if (f.type.kind === 'function') {
          closureFields.add(f.name)
        }
        if (f.type.kind === 'named' && f.type.name === node.name) {
          recursiveFields.add(`${v.name}/${f.name}`)
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
  // THE RESULT LOWERING (note/term/hive/11-native-exceptions.md, "Way 2"). A task whose raise set is not empty returns
  // `Result<T, TermException>`; `halt <form>` is `return Err(..)`; a call to a raising task is `call()?` inside a
  // raising task or a guarded body, and `.unwrap_or_else(exit 1 with form and note)` elsewhere, so a raise nothing
  // handles ends the program the way it does on every backend. A guard body is a closure returning
  // `Result<Option<T>, TermException>`: `Ok(Some(v))` is a `send back` inside it, `Ok(None)` falls through, and
  // `Err(e)` runs the handler with `e` bound.
  const raising = new Set<string>()
  let currentRaising = false
  let currentResult: Type | undefined
  let guardDepth = 0
  // set by an `await` around a raising call, so the `?` lands after `.await` and not before it
  let awaitedRaise = false

  const raiseSuffix = (): string =>
    currentRaising || guardDepth > 0
      ? '?'
      : '.unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })'

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
  // the names the CURRENT function or closure body actually reassigns. A `let` only needs `mut` when something
  // later assigns to it: a list or map local is an `Rc<RefCell<...>>`, so `push` and `insert` mutate through the
  // cell and never touch the binding. Declaring every local `let mut` made rustc's unused_mut fire on all of
  // them, and a strict build treats that as fatal.
  let assignedVars = new Set<string>()

  const mutOf = (name: string): string => (assignedVars.has(name) ? 'mut ' : '')

  // the forms a `fill` / `melt` with a form walks, gathered while the bodies are emitted; their walkers ride at the
  // end of the module
  const fillSpecs = new Map<string, FormSpec>()
  const meltSpecs = new Map<string, FormSpec>()

  // every struct form's declared fields, for a construction that leaves some out; and the exception forms, whose
  // raise panics with the note
  const recordFields = new Map<string, { name: string; type: Type }[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && n.variants.length === 0)
      .map(n => [n.name, n.fields]),
  )
  const exceptionForms = new Set(
    program
      .filter((n): n is Extract<Statement, { form: 'record-type' }> => n.form === 'record-type' && Boolean(n.chain?.includes('exception')))
      .map(n => n.name),
  )

  for (const [name, raises] of raiseSets(program, exceptionForms).raises) {
    if (raises.size > 0) {
      raising.add(name)
    }
  }

  // a field value that is a variable or a member read is cloned into the struct, the way an argument is, so the
  // binding it came from stays usable (a closure is not Clone and passes as is)
  const owned = (value: Expression): string =>
    (value.form === 'variable' || value.form === 'member') &&
    value.type &&
    value.type.kind !== 'function' &&
    !(value.form === 'variable' && cellVars.has(value.name))
      ? `${expr(value)}.clone()`
      : expr(value)

  // a value flowing into an `unknown` slot boxes (`std::rc::Rc::new`; the unsized coercion supplies `dyn Any` from
  // the slot's declared type). Only a read or a call whose own type is unknown is already the boxed dynamic; a
  // literal the checker typed unknown by expectation (a `code 0` bound into an unknown field) still needs the box,
  // and a bare integer pins to i64 so a later downcast sees the seed number type
  const boxUnknown = (
    into: Type | undefined,
    value: Expression,
    rendered: string,
  ): string => {
    if (into?.kind !== 'unknown') {
      return rendered
    }

    const alreadyBoxed =
      (value.form === 'variable' ||
        value.form === 'member' ||
        value.form === 'call' ||
        value.form === 'await') &&
      value.type?.kind === 'unknown'

    if (alreadyBoxed) {
      return rendered
    }

    return value.form === 'integer'
      ? `std::rc::Rc::new((${rendered}) as i64)`
      : `std::rc::Rc::new(${rendered})`
  }

  // every task's declared parameter types, for boxing an argument into an `unknown` parameter
  const functionParams = new Map<string, (Type | undefined)[]>(
    program
      .filter((n): n is Extract<Statement, { form: 'function' }> => n.form === 'function')
      .map(n => [n.name, n.params.map(p => p.type)]),
  )

  // an empty list or map binding spells its checked type, so rust does not have to infer it from later use
  const emptyAnn = (init: Expression): string => {
    const empty =
      (init.form === 'array' && init.items.length === 0) ||
      (init.form === 'map' && init.entries.length === 0) ||
      (init.form === 'record' && (init.name === 'list' || init.name === 'hash') && init.fields.length === 0)
    const known = init.type && init.type.kind !== 'variable' && init.type.kind !== 'unknown'

    return empty && known ? `: ${rustType(init.type)}` : ''
  }

  // the empty value of a type: what a left-out field or argument holds

  // a condition in a `while` / `if` head drops its self-parenthesization, since rustc warns on `while (a > b)`
  // (unused_parens) and a strict build makes the warning fatal. This used to apply only to a BINARY comparison,
  // which left every other self-parenthesizing form to trip the warning: a negated comparison renders `(!(a ==
  // b))` and failed the pdf package's Rust build the moment one was written as an `if` head. The paren-depth
  // scan below is what makes the strip safe, so it does not need the form to be anything in particular.
  const condExpr = (cond: Expression): string => {
    const rendered = expr(cond)

    if (!rendered.startsWith('(') || !rendered.endsWith(')')) {
      return rendered
    }

    // strip the pair only when the FIRST paren really closes at the last character. Parens INSIDE a string
    // literal do not count: `(char == ")".to_string())` closes at the `)` within the string otherwise, the scan
    // gives up, and rustc's unused_parens then fails a strict build on a condition that compares against a
    // bracket character — which is most of a PDF or JSON reader.
    let depth = 0
    let inString = false

    for (let i = 0; i < rendered.length; i++) {
      const c = rendered[i]

      if (inString) {
        if (c === '\\') {
          i++
        } else if (c === '"') {
          inString = false
        }

        continue
      }

      if (c === '"') {
        inString = true
      } else if (c === '(') {
        depth++
      } else if (c === ')') {
        depth--

        if (depth === 0 && i < rendered.length - 1) {
          return rendered
        }
      }
    }

    return rendered.slice(1, -1)
  }

  const emptyOf = (type: Type | undefined): string => {
    switch (type?.kind) {
      case 'string':
        return 'String::new()'
      case 'boolean':
        return 'false'
      case 'float':
        return '0.0'
      case 'bytes':
        return 'Vec::new()'
      case 'array':
        return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
      case 'map':
        return 'std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new()))'
      case 'named':
        if (type.name === 'text') {
          return 'String::new()'
        }

        if (type.name === 'boolean') {
          return 'false'
        }

        if (type.name === 'maybe') {
          return 'Maybe::None'
        }

        if (type.name === 'list') {
          return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
        }

        if (type.name === 'hash') {
          return 'std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new()))'
        }

        return '0'
      case 'unknown':
        // an unknown field left out of a construction: a boxed unit (the slot carries anything)
        return 'std::rc::Rc::new(())'
      default:
        return '0'
    }
  }

  // module-level bindings (`host hex-alpha, text <...>` at the top of a module): rust has no top-level `let`, so
  // each becomes a `thread_local!` static and every read clones the value out. A function parameter or local of
  // the same name shadows it, tracked in `localNames` while a function body is emitted.
  const moduleConsts = new Set<string>(
    program.filter((n): n is Extract<Statement, { form: 'let' }> => n.form === 'let').map(n => n.name),
  )
  const localNames = new Set<string>()
  const moduleConstName = (name: string): string => `MODULE_${snake(name).toUpperCase()}`

  // a module-level `host` data tree (`host range` / `host h` / `host start, code 0`) is an ANONYMOUS nested
  // record: no form names it, so Rust gets one synthesized struct per record node, named by the binding and
  // the field path (HostRange, HostRangeH). The record nodes are renamed in place so the construction and the
  // static's type line up, and the struct defs ride ahead of the module lets.
  const hostStructDefs: string[] = []
  const hostStructOf = new Map<string, string>()
  const hostLeafType = (v: Expression): string =>
    v.form === 'integer'
      ? 'i64'
      : v.form === 'float'
        ? 'f64'
        : v.form === 'string'
          ? 'String'
          : v.form === 'boolean'
            ? 'bool'
            : v.type
              ? rustType(v.type)
              : 'i64'
  const nameHostRecord = (
    node: Extract<Expression, { form: 'record' }>,
    base: string,
  ): string => {
    node.name = base

    const fields = node.fields.map(f => {
      const type =
        f.value.form === 'record' && f.value.name === ''
          ? nameHostRecord(f.value, `${base}${pascal(f.name)}`)
          : hostLeafType(f.value)

      return `pub ${snake(f.name)}: ${type}`
    })

    hostStructDefs.push(
      `#[derive(Clone)] pub struct ${base} { ${fields.join(', ')} }`,
    )

    return base
  }

  for (const node of program) {
    if (
      node.form === 'let' &&
      node.init.form === 'record' &&
      node.init.name === ''
    ) {
      hostStructOf.set(
        node.name,
        nameHostRecord(node.init, `Host${pascal(node.name)}`),
      )
    }
  }

  // a valueless typed module SLOT (`host current, like context`, filled later by a `save`): rust has no
  // lateinit, so the static is a RefCell<Option<T>>; reads unwrap, writes fill (see the variable and assign
  // cases)
  const moduleSlots = new Set<string>(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'let' }> =>
          n.form === 'let' &&
          n.init.form === 'unit' &&
          n.type !== undefined &&
          n.type.kind === 'named',
      )
      .map(n => n.name),
  )

  const moduleLet = (node: Extract<Statement, { form: 'let' }>): string =>
    moduleSlots.has(node.name)
      ? `thread_local! { static ${moduleConstName(node.name)}: std::cell::RefCell<Option<${rustType(node.type)}>> = std::cell::RefCell::new(None); }`
      : `thread_local! { static ${moduleConstName(node.name)}: ${
          hostStructOf.get(node.name) ?? rustType(node.init.type ?? node.type)
        } = ${expr(node.init)}; }`

  const isNativeCall = (node: Expression): boolean => {
    // SEE THROUGH AN AWAIT. `send back / call shim/list-them / wait true` is an `await` node wrapping the call,
    // and it is the same call: an asynchronous shim returns a plain `Vec<T>` exactly as a synchronous one does.
    // Not looking through it meant a list-returning `note async` task emitted the bare `Vec` where the signature
    // says `Rc<RefCell<Vec<T>>>`, while the SYNCHRONOUS form of the same task compiled clean. The swift emitter
    // had the identical blind spot.
    const call = node.form === 'await' ? node.expr : node

    if (call.form !== 'call' || call.callee.form !== 'member') {
      return false
    }

    const root = rootVariable(call.callee)

    return root !== undefined && aliases.has(root)
  }

  // a generic struct whose fields never mention one of its parameters (an opaque `dock` erases the type) needs
  // a PhantomData field for the unused letters, or rustc refuses it (E0392). Detected up front so every
  // construction of the form appends the marker regardless of declaration order.
  const phantomForms = new Map<string, string>()

  for (const node of program) {
    if (
      node.form !== 'record-type' ||
      node.params.length === 0 ||
      node.variants.length > 0
    ) {
      continue
    }

    const rendered = node.fields.map(f => rustType(f.type)).join(', ')
    const unused = node.params
      .map(p => p.toUpperCase())
      .filter(p => !new RegExp(`\\b${p}\\b`).test(rendered))

    if (unused.length > 0) {
      phantomForms.set(
        node.name,
        unused.length === 1 ? unused[0]! : `(${unused.join(', ')})`,
      )
    }
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
      case 'template': {
        // `format!`: braces in the chunks doubled, one `{}` per expression (Display covers text, numbers, flags)
        const shape = node.parts
          .map(part => (typeof part === 'string' ? JSON.stringify(part).slice(1, -1).replace(/[{}]/g, '$&$&') : '{}'))
          .join('')
        const args = node.parts.filter((part): part is Expression => typeof part !== 'string').map(expr)

        return `format!(${[JSON.stringify(shape).replace(/\\\\/g, '\\'), ...args].join(', ')})`
      }
      case 'unit':
        return '()'
      case 'null':
        // null lives in the dynamic currency, which is `serde_json::Value` on rust
        return 'serde_json::Value::Null'
      case 'variable':
      case 'hole':
        // a module-level constant lives in a thread_local (rust has no top-level `let`): a read clones it out
        if (moduleConsts.has(node.name) && !localNames.has(node.name)) {
          return moduleSlots.has(node.name)
            ? `${moduleConstName(node.name)}.with(|v| v.borrow().clone().unwrap())`
            : `${moduleConstName(node.name)}.with(|v| v.clone())`
        }

        // a mutated capture lives in an Rc<RefCell> handle: a read borrows and clones the value out
        return cellVars.has(node.name)
          ? `${vname(node.name)}.borrow().clone()`
          : vname(node.name)
      case 'unary':
        return `${node.op}${expr(node.operand)}`
      case 'binary': {
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

        // comparing an unknown slot to `make void` is a presence check: Rc<dyn Any> has no `==`, so it asks
        // the box whether it holds the unit
        const voidSide =
          node.right.form === 'record' && node.right.name === 'void'
            ? node.left
            : node.left.form === 'record' && node.left.name === 'void'
              ? node.right
              : undefined

        if (voidSide && (node.op === '==' || node.op === '!=')) {
          const check = `${expr(voidSide)}.is::<()>()`

          return node.op === '==' ? check : `!${check}`
        }

        return `(${expr(node.left)} ${OP[node.op]} ${expr(node.right)})`
      }

      case 'call': {
        // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: a function per form, generated
        // from the form's fields at the end of the module (see formWalk below)
        if (
          node.callee.form === 'variable' &&
          (node.callee.name === 'fill-form' || node.callee.name === 'melt-form') &&
          node.into
        ) {
          const spec = formSpec(node.into, recordFields)
          refuseAny(spec, 'Rust')
          const into = node.callee.name === 'fill-form' ? fillSpecs : meltSpecs
          specForms(spec, into)

          return node.callee.name === 'fill-form'
            ? `__fill_${snake(spec.form)}(${expr(node.args[0]!)}, String::new())`
            : `__melt_${snake(spec.form)}(${expr(node.args[0]!)})`
        }

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

        // a host string method (what `text.tree` delegates to) lowers to rust's str API
        const text = stringCall(node.callee)

        if (text) {
          return stringExpr(text.op, expr(text.target), node.args.map(a => expr(a)))
        }

        // Rust moves a value passed by value, so a local (or a field read out of a struct) used as an argument would
        // move it away. Cloning a non-function variable / field argument is transparent here -- every collection is an
        // `Rc` (a cheap shared handle), every struct derives `Clone`, scalars are `Copy` -- and frees callers from
        // manual ownership juggling. A closure is function-typed (`Box<dyn Fn>`, not `Clone`), so it passes unchanged.
        // MOVE ON LAST USE: a bare variable read exactly once in the function (and not in a loop or closure) is moved at
        // this use instead of cloned -- there is no later use to invalidate, so the borrow checker accepts it, and the
        // clone (a deep `String` copy or an `Rc` refcount bump) is saved.
        // a closure-typed local (a task parameter) boxes its unknown-typed arguments the same way a known
        // function does: its param types come from the callee's own checked function type
        const params =
          node.callee.form === 'variable'
            ? (functionParams.get(node.callee.name) ??
              (node.callee.type?.kind === 'function'
                ? node.callee.type.params
                : undefined))
            : undefined
        const argList = node.args.map((a, i) => {
          const rendered = (() => {
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
          })()

          // a binary's grouping parens are redundant at argument position (the comma delimits):
          // rustc warns unused_parens on them
          return bare(boxUnknown(params?.[i], a, rendered))
        })

        // a trailing `need false` parameter left out at the call site still exists in the native signature:
        // fill it with its type's empty value (the boxed unit for an unknown)
        if (params && params.length > argList.length) {
          for (let i = argList.length; i < params.length; i++) {
            const missing = params[i]

            argList.push(
              missing?.kind === 'unknown' || missing === undefined
                ? '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
                : emptyOf(missing),
            )
          }
        }

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

        if (node.callee.form === 'variable' && raising.has(node.callee.name)) {
          const suffix = awaitedRaise ? '' : raiseSuffix()
          awaitedRaise = false

          return `${expr(node.callee)}(${args})${suffix}`
        }

        return `${expr(node.callee)}(${args})`
      }

      case 'array':
        return `std::rc::Rc::new(std::cell::RefCell::new(vec![${node.items
          .map(expr)
          .join(', ')}]))`

      case 'record': {
        // `make hash` / `make list` with no binds are the native collections, not record constructions (the
        // pascal of `hash` would otherwise resolve to the std `Hash` derive macro)
        if (node.name === 'hash' && node.fields.length === 0) {
          return 'std::rc::Rc::new(std::cell::RefCell::new(std::collections::HashMap::new()))'
        }

        if (node.name === 'list' && node.fields.length === 0) {
          return 'std::rc::Rc::new(std::cell::RefCell::new(Vec::new()))'
        }

        // `make void` is the absent value: the boxed unit, so an unknown slot can hold and recognize it
        if (node.name === 'void' && node.fields.length === 0) {
          return '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
        }

        // a label several enums share (`text` on both `token` and `data`) is owned by the enum the checker gave the
        // construction; a label of one enum by that enum
        const owner =
          node.type?.kind === 'named' && variantOwners.get(node.name)?.has(node.type.name)
            ? node.type.name
            : variantOwner.get(node.name)

        if (owner) {
          const fields = node.fields.map(
            f =>
              `${snake(f.name)}: ${
                recursiveFields.has(`${node.name}/${f.name}`)
                  ? `std::rc::Rc::new(${owned(f.value)})`
                  : owned(f.value)
              }`,
          )

          return fields.length > 0
            ? `${pascal(owner)}::${pascal(node.name)} { ${fields.join(
                ', ',
              )} }`
            : `${pascal(owner)}::${pascal(node.name)}`
        }

        // a field the construction leaves out (`need false`, or one the runtime fills on another backend) takes its
        // type's empty value, so the struct is whole
        const given = new Set(node.fields.map(f => f.name))
        const declared = new Map(
          (recordFields.get(node.name) ?? []).map(f => [f.name, f.type]),
        )
        const missing = (recordFields.get(node.name) ?? [])
          .filter(f => !given.has(f.name))
          .map(f => `${snake(f.name)}: ${emptyOf(f.type)}`)

        return `${pascal(node.name)} { ${[
          ...node.fields.map(
            f =>
              `${snake(f.name)}: ${boxUnknown(declared.get(f.name), f.value, owned(f.value))}`,
          ),
          ...missing,
          ...(phantomForms.has(node.name)
            ? ['_marker: std::marker::PhantomData']
            : []),
        ].join(', ')} }`
      }

      case 'member': {
        // a DYNAMIC segment (`read table/{key}`) indexes the collection through its handle; cloned out, since
        // indexing a Vec of non-Copy values (String, Rc) cannot move
        if (node.index) {
          return `${expr(node.target)}.borrow()[${expr(node.index)} as usize].clone()`
        }

        // `map.size` / `array.length` read the length (a map goes through its Rc<RefCell> handle; an array is a plain
        // Vec). Rendered as i64, the seed number type.
        const read = collectionRead(node)

        if (read) {
          // both a map and an array read their length through the Rc<RefCell> handle
          return `(${expr(read.target)}.borrow().len() as i64)`
        }

        const textLength = stringRead(node)

        if (textLength) {
          return `(${expr(textLength.target)}.chars().count() as i64)`
        }

        // a LITERAL index segment (`read parts/0`) on an array target indexes the Vec: `.0` would be a tuple
        // field, which an Rc<RefCell<Vec>> does not have
        if (
          /^\d+$/.test(node.name) &&
          node.target.type?.kind === 'array'
        ) {
          return `${expr(node.target)}.borrow()[${node.name}]`
        }

        return memberPath(node)
      }

      case 'await': {
        if (node.expr.form === 'call' && node.expr.callee.form === 'variable' && raising.has(node.expr.callee.name)) {
          awaitedRaise = true
          const inner = expr(node.expr)
          awaitedRaise = false

          return `${inner}.await${raiseSuffix()}`
        }

        // `wait true` on a call whose callee is checked SYNC (a plain task field): rustc refuses awaiting a
        // non-future, so the await is dropped rather than emitted
        if (node.expr.form === 'call') {
          const calleeType =
            node.expr.callee.type?.kind === 'function'
              ? node.expr.callee.type
              : undefined

          if (calleeType && !calleeType.effects?.includes('async')) {
            return expr(node.expr)
          }
        }

        return `${expr(node.expr)}.await`
      }
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
        const previousAssignedInClosure = assignedVars
        assignedVars = mutated

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
        assignedVars = previousAssignedInClosure

        // an async closure becomes a plain `Fn` whose body is a pinned async block: calling it returns a future the
        // caller `.await`s (Rust closures can't themselves be `async`). The `let`/parameter type annotation supplies
        // the `Pin<Box<dyn Future>>` return so the concrete async block coerces to the boxed trait object.
        const boxed = node.async
          ? `std::rc::Rc::new(move |${params}| std::boxed::Box::pin(async move { ${body} }))`
          : `std::rc::Rc::new(move |${params}| { ${body} })`

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
      case 'get':
        return `${data}[(${arg[0]}) as usize].clone()`
      case 'set':
        return `{ ${target}.borrow_mut()[(${arg[0]}) as usize] = ${arg[1]}; }`
      case 'includes':
        return `${data}.contains(&${arg[0]})`
      case 'indexOf':
        return `${data}.iter().position(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
      case 'lastIndexOf':
        return `${data}.iter().rposition(|e| *e == ${arg[0]}).map(|i| i as i64).unwrap_or(-1)`
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

  // JavaScript's string methods over rust's String (see backend.ts, STRING_METHODS). Positions count chars; a read
  // past the end is empty (charAt) or 0 (charCodeAt), never a panic. Each borrows the receiver, so a local read here
  // is not moved away.
  const stringExpr = (op: string, t: string, a: string[]): string => {
    switch (op) {
      case 'charAt':
      case 'at':
        return `{ let h: &str = &${t}; let i = ${a[0]}; if i < 0 { String::new() } else { h.chars().nth(i as usize).map(|c| c.to_string()).unwrap_or_default() } }`
      case 'charCodeAt':
        return `{ let h: &str = &${t}; let i = ${a[0]}; if i < 0 { 0 } else { h.encode_utf16().nth(i as usize).map(|c| c as i64).unwrap_or(0) } }`
      case 'indexOf':
        return `{ let h: &str = &${t}; let n: String = ${a[0]}; let from = (${a[1] ?? '0'}).max(0) as usize; let start = h.char_indices().nth(from).map(|(b, _)| b).unwrap_or(h.len()); match h[start..].find(n.as_str()) { Some(b) => h[..start + b].chars().count() as i64, None => -1 } }`
      case 'lastIndexOf':
        return `{ let h: &str = &${t}; let n: String = ${a[0]}; match h.rfind(n.as_str()) { Some(b) => h[..b].chars().count() as i64, None => -1 } }`
      case 'split':
        return `std::rc::Rc::new(std::cell::RefCell::new({ let h: &str = &${t}; let d: String = ${a[0]}; if d.is_empty() { h.chars().map(|c| c.to_string()).collect::<Vec<String>>() } else { h.split(d.as_str()).map(|s| s.to_string()).collect::<Vec<String>>() } }))`
      case 'substring':
      case 'slice':
        return `{ let h: &str = &${t}; let n = h.chars().count() as i64; let x = (${a[0]}).max(0).min(n); let y = (${a[1] ?? 'n'}).max(0).min(n); let (x, y) = if x <= y { (x, y) } else { (y, x) }; h.chars().skip(x as usize).take((y - x) as usize).collect::<String>() }`
      case 'toLowerCase':
        return `${t}.to_lowercase()`
      case 'toUpperCase':
        return `${t}.to_uppercase()`
      case 'startsWith':
        return `{ let n: String = ${a[0]}; ${t}.starts_with(n.as_str()) }`
      case 'endsWith':
        return `{ let n: String = ${a[0]}; ${t}.ends_with(n.as_str()) }`
      case 'trim':
        return `${t}.trim().to_string()`
      case 'trimStart':
        return `${t}.trim_start().to_string()`
      case 'trimEnd':
        return `${t}.trim_end().to_string()`
      case 'padStart':
        return `{ let mut o: String = ${t}; let f: String = ${a[1]}; while (o.chars().count() as i64) < (${a[0]}) && !f.is_empty() { o = format!("{}{}", f, o); } o }`
      case 'padEnd':
        return `{ let mut o: String = ${t}; let f: String = ${a[1]}; while (o.chars().count() as i64) < (${a[0]}) && !f.is_empty() { o = format!("{}{}", o, f); } o }`
      case 'replace':
        return `{ let a: String = ${a[0]}; let b: String = ${a[1]}; ${t}.replacen(a.as_str(), b.as_str(), 1) }`
      case 'replaceAll':
        return `{ let a: String = ${a[0]}; let b: String = ${a[1]}; ${t}.replace(a.as_str(), b.as_str()) }`
      case 'includes':
        return `{ let n: String = ${a[0]}; ${t}.contains(n.as_str()) }`
      case 'concat':
        return `format!("{}{}", ${t}, ${a[0]})`
      case 'repeat':
        return `${t}.repeat((${a[0]}).max(0) as usize)`
      default:
        return ''
    }
  }

  const block = (body: Statement[], d: number): string =>
    body
      .map(s => `${pad(d)}${stmt(s, d)}`)
      .filter(Boolean)
      .join('\n')

  const stmt = (node: Statement, d: number): string => {
    switch (node.form) {
      case 'let': {
        // the gradual boundary on a binding: `host record, like test-entry / read entry/base` re-types the
        // boxed dynamic at a declared FORM, which on rust is a downcast out of the box
        if (
          node.type?.kind === 'named' &&
          node.init.form === 'member' &&
          recordFields.has(node.type.name) &&
          (node.init.type?.kind === 'unknown' ||
            node.init.type?.kind === 'dynamic')
        ) {
          return `let ${mutOf(node.name)}${vname(node.name)} = ${expr(node.init)}.downcast_ref::<${rustType(node.type)}>().unwrap().clone();`
        }

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

        // a local declared `like unknown` boxes its concrete init, so every later read is already the boxed dynamic
        if (node.type?.kind === 'unknown' && node.init.type?.kind !== 'unknown') {
          return `let ${mutOf(node.name)}${vname(node.name)}: std::rc::Rc<dyn std::any::Any> = std::rc::Rc::new(${owned(node.init)});`
        }

        return `let ${mutOf(node.name)}${vname(node.name)}${ann || emptyAnn(node.init)} = ${bare(owned(node.init))};`
      }
      case 'assign': {
        // an assignment to a mutated capture writes through the cell: `*x.borrow_mut() = v`, and a field of a
        // cell-boxed struct writes through the borrowed root: `x.borrow_mut().field = v`. The value computes into a
        // temporary FIRST: a `x.borrow()` inside it is a temporary `Ref` guard that lives to the end of its whole
        // statement, so evaluating it in the same statement as the `borrow_mut` would panic at run time
        // (`RefCell already borrowed`). The inner `let` scopes that guard to its own statement.
        // a write to a module SLOT fills the thread_local's Option
        if (
          node.target.form === 'variable' &&
          moduleSlots.has(node.target.name) &&
          !localNames.has(node.target.name)
        ) {
          return `{ let __slot_value = ${bare(owned(node.value))}; ${moduleConstName(node.target.name)}.with(|v| *v.borrow_mut() = Some(__slot_value)); }`
        }

        const cellTarget = cellAssignTarget(node.target)

        if (cellTarget) {
          return `{ let __cell_value = ${bare(
            expr(node.value),
          )}; ${cellTarget} ${node.op} __cell_value; }`
        }

        return node.op === '='
          ? `${expr(node.target)} = ${bare(owned(node.value))};`
          : `${expr(node.target)} ${node.op} ${bare(expr(node.value))};`
      }
      case 'expression':
        return `${expr(node.expr)};`
      case 'return': {

        // a list-returning function that returns a native dock call directly wraps the shim's plain `Vec`
        const value = !node.value
          ? '()'
          : fnReturnsArray && isNativeCall(node.value)
            ? wrapList(expr(node.value))
            : bare(boxUnknown(currentResult, node.value, expr(node.value)))

        // the gradual boundary: an unknown-typed value returned at a declared FORM type downcasts
        const valueKind =
          node.value?.form === 'await'
            ? (node.value.type ?? node.value.expr.type)?.kind
            : node.value?.type?.kind
        // only a FIELD READ is certainly the boxed dynamic; a dock call's rust value is already concrete,
        // and downcasting a plain struct does not compile
        const casted =
          node.value &&
          node.value.form === 'member' &&
          (valueKind === 'unknown' || valueKind === 'dynamic') &&
          currentResult?.kind === 'named' &&
          recordFields.has(currentResult.name)
            ? `${value}.downcast_ref::<${rustType(currentResult)}>().unwrap().clone()`
            : value

        // a bare `send back` in a task whose synthesized result is the boxed dynamic answers the boxed unit
        const boxedUnit =
          !node.value && currentResult?.kind === 'unknown'
            ? '(std::rc::Rc::new(()) as std::rc::Rc<dyn std::any::Any>)'
            : undefined

        if (guardDepth > 0) {
          return `return std::result::Result::Ok(Some(${boxedUnit ?? casted}));`
        }

        if (currentRaising) {
          return `return std::result::Result::Ok(${boxedUnit ?? casted});`
        }

        return node.value || boxedUnit ? `return ${boxedUnit ?? casted};` : 'return;'
      }
      case 'throw': {
        // a raise is `Err(TermException)`: the record's shared fields, its props as `link`, the record as `base`; a
        // text raises `failure`; a caught value passes on as it is. Outside any raising task or guard (a raise the
        // checker did not see reach here) it still ends the program, with the form and note. When the program has
        // the stdlib hive, a NEW carrier tells it before unwinding (a pass-on re-raise does not re-tell), the same
        // hook the TypeScript constructor carries.
        const tell = (built: string): string =>
          hasHiveTell
            ? `{ let told = ${built}; hive_tell(HiveEntry { host: told.host.clone(), kind: "exception".to_string(), name: told.form.clone(), site: String::new(), base: std::rc::Rc::new(told.clone()) }); told }`
            : built
        const carrier =
          node.value.form === 'string'
            ? tell(
                `TermException { host: String::new(), form: "failure".to_string(), note: ${expr(node.value)}, code: String::new(), time: 0, link: std::rc::Rc::new(()), base: std::rc::Rc::new(()) }`,
              )
            : node.value.form === 'record' && exceptionForms.has(node.value.name)
              ? tell(
                  `{ let raised = ${expr(node.value)}; TermException { host: raised.host.clone(), form: raised.form.clone(), note: raised.note.clone(), code: raised.code.clone(), time: raised.time, link: std::rc::Rc::new(raised.link.clone()), base: std::rc::Rc::new(raised) } }`,
                )
              : `(${expr(node.value)}).clone()`

        if (currentRaising || guardDepth > 0) {
          return `return std::result::Result::Err(${carrier});`
        }

        return `{ let raised = ${carrier}; eprintln!("{}", raised); std::process::exit(1) }`
      }
      case 'while':
        // `while true` emits `loop`, which rustc knows diverges: a function ending in the loop then needs no
        // unreachable trailing value (E0308)
        if (node.cond.form === 'boolean' && node.cond.value === true) {
          return `loop {\n${block(node.body, d + 1)}\n${pad(d)}}`
        }

        return `while ${condExpr(node.cond)} {\n${block(
          node.body,
          d + 1,
        )}\n${pad(d)}}`
      case 'guard': {
        // the body runs as a closure returning Result<Option<T>, TermException>, T the enclosing task's result: a
        // `send back` inside it is Ok(Some(v)) and returns from the task after the match, falling off the end is
        // Ok(None), a raise (its own, or a callee's through `?`) is Err(e) and runs the handler with e bound
        const result = currentResult && currentResult.kind !== 'unit' ? rustType(currentResult) : '()'
        const outerRaising = currentRaising
        guardDepth++
        const body = block(node.body, d + 2)
        guardDepth--
        const returned = outerRaising ? 'return std::result::Result::Ok(value)' : 'return value'
        const handler = node.catch
          ? `std::result::Result::Err(${vname(node.catch.name)}) => {\n${block(node.catch.body, d + 2)}\n${pad(d + 1)}}`
          : 'std::result::Result::Err(_) => {}'

        return `match (|| -> std::result::Result<Option<${result}>, TermException> {\n${body}\n${pad(d + 1)}std::result::Result::Ok(None)\n${pad(d)}})() {\n${pad(d + 1)}std::result::Result::Ok(Some(value)) => ${returned},\n${pad(d + 1)}std::result::Result::Ok(None) => {}\n${pad(d + 1)}${handler}\n${pad(d)}}`
      }

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
        // a fork case over a caught TermException: match on `form`, the record recovered from `base` by its form
        if (node.exceptionArms) {
          const carrier = expr(node.subject)
          const arms = node.cases.map(b => {
            const arm = node.exceptionArms![b.label]!
            const bodyText = block(b.body, d + 2)
            const locals = armLocals([...arm.shared, ...arm.link], b.binds)
              .filter(({ local }) => new RegExp(`\\b${snake(local)}\\b`).test(bodyText))
              .map(({ field, local }) =>
                arm.link.includes(field)
                  ? `${pad(d + 2)}let ${snake(local)} = ${carrier}.base.downcast_ref::<${pascal(b.label)}>().unwrap().link.${snake(field)}.clone();`
                  : `${pad(d + 2)}let ${snake(local)} = ${carrier}.${snake(field)}.clone();`,
              )

            return `${pad(d + 1)}${JSON.stringify(b.label)} => {\n${[...locals, bodyText].join('\n')}\n${pad(d + 1)}}`
          })
          arms.push(`${pad(d + 1)}_ => {${node.otherwise ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}` : ''}}`)

          return `match ${carrier}.form.as_str() {\n${arms.join('\n')}\n${pad(d)}}`
        }

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

        // a `fork case` over a TEXT subject (`fork case, read kind` with `case home` arms): the labels are
        // string values, matched over &str with a wildcard for exhaustiveness
        if (node.subject.type?.kind === 'string') {
          const arms = node.cases.map(
            b =>
              `${pad(d + 1)}${JSON.stringify(b.label)} => {\n${block(
                b.body,
                d + 2,
              )}\n${pad(d + 1)}}`,
          )

          arms.push(
            `${pad(d + 1)}_ => {${
              node.otherwise
                ? `\n${block(node.otherwise, d + 2)}\n${pad(d + 1)}`
                : ''
            }}`,
          )

          return `match ${expr(node.subject)}.as_str() {\n${arms.join('\n')}\n${pad(d)}}`
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
          const subjectType = node.subject.type
          const owner =
            subjectType?.kind === 'named' && variantOwners.get(b.label)?.has(subjectType.name)
              ? subjectType.name
              : (variantOwner.get(b.label) ?? '')
          const fields = variantFields.get(b.label) ?? []
          // bind the variant's fields so the branch body can read them; narrow the subject for this arm so a
          // `subject/field` read resolves to the bound local (restored after the arm so sibling arms are unaffected)
          // the arm's `link` lines select or rename the fields (see check/arm.ts); a field left out is `..`
          const locals = armLocals(fields, b.binds)
          const pattern =
            fields.length > 0
              ? ` { ${[
                  ...locals.map(({ field, local }) =>
                    field === local ? snake(field) : `${snake(field)}: ${snake(local)}`,
                  ),
                  ...(locals.length < fields.length ? ['..'] : []),
                ].join(', ')} }`
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

          // a recursive field arrives Rc-wrapped (see recursiveFields); clone it out so the branch body
          // sees the plain enum value it was written against
          const unwraps = locals
            .filter(({ field }) => recursiveFields.has(`${b.label}/${field}`))
            .map(
              ({ local }) =>
                `${pad(d + 2)}let ${snake(local)} = (*${snake(local)}).clone();`,
            )

          return `${pad(d + 1)}${pascal(owner)}::${pascal(
            b.label,
          )}${pattern} => {\n${[...unwraps, body].join('\n')}\n${pad(d + 1)}}`
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
          out += `${i ? ' else ' : ''}if ${condExpr(b.cond)} {\n${block(
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
        // the names this function binds itself (parameters and locals) shadow a module-level constant of the same name
        localNames.clear()
        node.params.forEach(p => localNames.add(p.name))
        letNames(node.body, localNames)

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
          // every generic is 'static: our values own their data (String, i64, Rc), and the generic runtime
          // shims (shape, compare, text) require it for the Any-based dispatch
          const traits = ['Clone', "'static"]

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

        // a task with no declared result but a valued `send back` (a dock forward) answers the boxed dynamic
        const declaredResult =
          node.result && node.result.kind !== 'unit'
            ? node.result
            : hasValuedReturn(node.body)
              ? ({ kind: 'unknown' } as Type)
              : node.result
        const plainResult =
          declaredResult && declaredResult.kind !== 'unit' ? rustType(declaredResult) : ''
        const ret = raising.has(node.name)
          ? ` -> std::result::Result<${plainResult || '()'}, TermException>`
          : plainResult
            ? ` -> ${plainResult}`
            : ''
        const previousRaising = currentRaising
        const previousResult = currentResult
        currentRaising = raising.has(node.name)
        currentResult = declaredResult

        // names a nested closure ASSIGNS to are boxed in Rc<RefCell> for this whole function body
        const previousCellVars = cellVars
        cellVars = mutatedCaptures(node.body)

        // reassigned parameters are shadowed by `let mut` (Rust parameters are immutable). A parameter that is a
        // MUTATED CAPTURE gets its Rc<RefCell> handle shadow instead.
        const mutated = new Set<string>()
        reassigned(node.body, mutated)
        const previousAssigned = assignedVars
        assignedVars = mutated
        // A parameter mutated in place by `push` / `pop` needs NO rebinding: a list is
        // `Rc<RefCell<Vec<T>>>` here, so the mutation goes through `borrow_mut()` and the binding itself is
        // never assigned. Adding it produced `let mut slf = slf;` in `list_push` and `list_pop`, which rustc
        // reports as unused_mut and a strict build treats as fatal — the otf head package failed on exactly
        // that. Only a genuine REASSIGNMENT (handled by `reassigned` above) needs the shadow.

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

        // a raising task whose body falls off the end (a unit task) still answers Ok; a task whose last statement is
        // a guard returned from inside it (the body's or the handler's `send back`), which Rust cannot see through
        // the match, so the fall-through is marked unreachable
        const last = node.body[node.body.length - 1]
        // an if-chain WITH an else whose every branch visibly returns diverges in rustc's own analysis,
        // so an unreachable!() after it draws the unreachable_code warning instead of helping
        const rustSeesDivergence = (s: Statement | undefined): boolean => {
          const branchReturns = (body: Statement[]): boolean => {
            const end = body[body.length - 1]

            return (
              end?.form === 'return' ||
              end?.form === 'throw' ||
              rustSeesDivergence(end)
            )
          }

          if (s?.form === 'if') {
            return (
              Boolean(s.otherwise) &&
              s.branches.every(b => branchReturns(b.body)) &&
              branchReturns(s.otherwise!)
            )
          }

          // an ENUM match (rustc-checked exhaustive) with every arm returning: rustc sees it diverge.
          // The other match shapes get a wildcard arm from this emitter (text and exception subjects
          // always, bool with fewer than two literal arms), and an EMPTY wildcard keeps a live
          // fall-through, so only the shapes whose emitted arms all return count here.
          if (s?.form === 'match' && !s.exceptionArms) {
            const labels = s.cases.map(b => b.label)
            const booleans =
              labels.length > 0 &&
              labels.every(l => l === 'true' || l === 'false')
            const text = s.subject.type?.kind === 'string'
            const wildcard =
              text ||
              (booleans && (s.otherwise || s.cases.length < 2))

            if (wildcard || (booleans && s.cases.length < 2)) {
              // the wildcard arm is the otherwise (or empty): diverges only when an otherwise
              // exists and returns
              return (
                Boolean(s.otherwise) &&
                s.cases.every(b => branchReturns(b.body)) &&
                branchReturns(s.otherwise!)
              )
            }

            return (
              s.cases.every(b => branchReturns(b.body)) &&
              (!s.otherwise || branchReturns(s.otherwise))
            )
          }

          return false
        }
        const lastDiverges =
          last?.form === 'return' ||
          last?.form === 'throw' ||
          rustSeesDivergence(last)
        const tail =
          currentRaising &&
          (!node.result || node.result.kind === 'unit') &&
          !lastDiverges
            ? `${pad(d + 1)}std::result::Result::Ok(())`
            : (last?.form === 'guard' ||
                  last?.form === 'if' ||
                  last?.form === 'while' ||
                  last?.form === 'match') &&
                node.result &&
                node.result.kind !== 'unit' &&
                !rustSeesDivergence(last)
              ? // a valued task whose body ends in branching that returns from every live path: rustc cannot
                // always see the coverage (an `if` chain with no `else`), so the fall-through is marked
                `${pad(d + 1)}unreachable!()`
              : ''
        // a signature-only stub compiles: its body is the not-implemented panic
        const bodyText =
          node.body.length === 0
            ? `${pad(d + 1)}unimplemented!(${JSON.stringify(`stub: ${node.name}`)})`
            : [...shadows, block(node.body, d + 1), tail]
                .filter(Boolean)
                .join('\n')

        currentRaising = previousRaising
        currentResult = previousResult
        fnReturnsArray = previousReturnsArray
        moveArgs = previousMoveArgs
        cellVars = previousCellVars
        assignedVars = previousAssigned

        const asyncMark = node.async ? 'async ' : ''

        return `${asyncMark}fn ${snake(
          node.name,
        )}${generics}(${params})${ret} {\n${bodyText}\n${pad(d)}}`
      }

      case 'record-type': {
        const generics = node.params.length
          ? `<${node.params.map(p => p.toUpperCase()).join(', ')}>`
          : ''

        // every struct/enum is `Clone`: a closure field is an `Rc<dyn Fn>` (a cheap shared handle), so even a
        // record holding one clones. Deriving Clone lets a value be shared at a call site rather than moved --
        // the same property the Rc-wrapped collections rely on.
        const derive = `#[derive(Clone)]\n${pad(d)}`

        if (node.variants.length > 0) {
          const cases = node.variants.map(v => {
            const fields = v.fields.map(
              f =>
                `${snake(f.name)}: ${
                  recursiveFields.has(`${v.name}/${f.name}`)
                    ? `std::rc::Rc<${rustType(f.type)}>`
                    : rustType(f.type)
                }`,
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

        // a generic parameter no field mentions (an opaque `dock` handle erases it) still has to be used, or
        // rustc refuses the struct (E0392): a PhantomData field carries the unused letters, and every
        // construction of the form appends the marker (see the record case)
        if (phantomForms.has(node.name)) {
          fields.push(
            `${pad(d + 1)}_marker: std::marker::PhantomData<${phantomForms.get(node.name)}>`,
          )
        }

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
      case 'view':
      case 'dock':
      case 'tell':
      case 'roll':
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
    .map(n => `use ${n.module.replace(/::|[:/]/g, '::')};`)


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
    const path = need.module.replace(/::|[:/]/g, '::')
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

  // an abstract module's signature-only declaration and the platform module's implementation share a name by
  // design (platform dispatch): when both are in the closure, the stub yields to the implementation instead of
  // colliding with it (E0428)
  const implemented = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'function' }> =>
          n.form === 'function' && n.body.length > 0,
      )
      .map(n => n.name),
  )


  // a form declared in an abstract module AND its platform module lands twice in the closure: the empty
  // declaration yields to the full one, and an exact repeat keeps only its first appearance
  const fullForms = new Set(
    program
      .filter(
        (n): n is Extract<Statement, { form: 'record-type' }> =>
          n.form === 'record-type' &&
          (n.fields.length > 0 || n.variants.length > 0),
      )
      .map(n => n.name),
  )
  const seenForms = new Set<string>()
  // a module collected twice (two import spellings of one file) emits its functions twice: keep the first
  const seenFns = new Set<string>()
  const keepStatement = (n: Statement): boolean => {
    if (n.form === 'function') {
      const key = `${n.name}/${n.params.length}`

      if (seenFns.has(key)) {
        return false
      }

      seenFns.add(key)
    }

    if (n.form !== 'record-type') {
      return true
    }

    if (
      n.fields.length === 0 &&
      n.variants.length === 0 &&
      fullForms.has(n.name)
    ) {
      return false
    }

    if (seenForms.has(n.name)) {
      return false
    }

    seenForms.add(n.name)

    return true
  }

  const body = [
    ...hostStructDefs,
    ...program
      .filter(n => n.form !== 'native')
      .filter(
        n =>
          !(
            n.form === 'function' &&
            n.body.length === 0 &&
            implemented.has(n.name)
          ),
      )
      .filter(keepStatement)
      .map(n => (n.form === 'let' ? moduleLet(n) : stmt(n, 0))),
  ].filter(Boolean)

  const carrier = body.some(b => b.includes('TermException'))
    ? [
        `// the one exception value of a Term program on this backend (note/term/hive/11-native-exceptions.md)
#[derive(Clone)]
pub struct TermException { pub host: String, pub form: String, pub note: String, pub code: String, pub time: i64, pub link: std::rc::Rc<dyn std::any::Any>, pub base: std::rc::Rc<dyn std::any::Any> }
impl std::fmt::Display for TermException { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.form, self.note) } }
impl std::fmt::Debug for TermException { fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.form, self.note) } }
impl std::error::Error for TermException {}`,
      ]
    : []

  // the wake chain: one `hive_wake` per deck with its static entries, when the program has the stdlib hive and the
  // compile driver handed over the roll. A static entry's `base` is the declaration as JSON text, boxed; an entry
  // with a `ref` (a declared kind's constant) binds the live module constant instead. See note/term/hive/05-hive.md.
  const wake: string[] = []

  if (
    options?.wake?.length &&
    program.some(n => n.form === 'function' && n.name === 'hive-wake')
  ) {
    const entryText = (entry: Record<string, unknown>): string => {
      const { ref, base, ...own } = entry
      const boxed =
        typeof ref === 'string'
          ? `std::rc::Rc::new(${moduleConstName(ref)}.with(|v| v.clone()))`
          : `std::rc::Rc::new(${JSON.stringify(JSON.stringify(base ?? {}))}.to_string())`

      return `HiveEntry { host: ${JSON.stringify(String(own.host ?? ''))}.to_string(), kind: ${JSON.stringify(String(own.kind ?? ''))}.to_string(), name: ${JSON.stringify(String(own.name ?? ''))}.to_string(), site: ${JSON.stringify(String(own.site ?? ''))}.to_string(), base: ${boxed} }`
    }

    const calls = options.wake
      .map(
        group =>
          `    hive_wake(${JSON.stringify(group.deck)}.to_string(), std::rc::Rc::new(std::cell::RefCell::new(vec![${group.entries.map(entryText).join(', ')}])));`,
      )
      .join('\n')

    wake.push(`pub fn wake_hive() {\n${calls}\n}`)
  }

  return [...uses, ...carrier, ...body, ...rustFormWalk(fillSpecs, meltSpecs), ...wake].join('\n\n') + '\n'
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
// every name a body binds with `let`, at any depth (loop variables and match arms bind through their own forms
// and read through the same emitter paths, so a module constant of those names is shadowed the same way)
function letNames(body: Statement[], into: Set<string>): void {
  for (const s of body) {
    switch (s.form) {
      case 'let':
        into.add(s.name)
        break
      case 'if':
        s.branches.forEach(b => letNames(b.body, into))

        if (s.otherwise) {
          letNames(s.otherwise, into)
        }

        break
      case 'while':
      case 'for-each':
        if (s.form === 'for-each') {
          into.add(s.item)
        }

        letNames(s.body, into)
        break
      case 'match':
        s.cases.forEach(c => letNames(c.body, into))

        if (s.otherwise) {
          letNames(s.otherwise, into)
        }

        break
      case 'guard':
        letNames(s.body, into)

        if (s.catch) {
          letNames(s.catch.body, into)
        }

        break
      default:
        break
    }
  }
}

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

// ---- filling a form from data on rust ----

// the walkers a module's `fill` / `melt` with a form need: shared helpers over the package's `Data` enum, then a
// function per form. A value that does not fit panics the way a raise does on this backend, with the path and the
// reason of the `data-mismatch` the package raises elsewhere.
function rustFormWalk(fills: Map<string, FormSpec>, melts: Map<string, FormSpec>): string[] {
  if (fills.size === 0 && melts.size === 0) {
    return []
  }

  const out: string[] = [RUST_FORM_HELPERS]

  // an item of a list, or a field's value, read as its kind. `d` is a Data, `p` its path
  const fillOf = (kind: FormKind, value: string, path: string, optional: boolean): string => {
    switch (kind.kind) {
      case 'text':
        return `__term_text(${value}, ${path}, ${optional})`
      case 'number':
        return `__term_number(${value}, ${path}, ${optional})`
      case 'decimal':
        return `__term_decimal(${value}, ${path}, ${optional})`
      case 'flag':
        return `__term_flag(${value}, ${path}, ${optional})`
      case 'data':
        return `__term_data(${value}, ${path}, ${optional})`
      case 'list':
        return `__term_list(${value}, ${path}, ${optional}, &|d: Data, p: String| ${fillOf(kind.item, 'Some(d)', 'p', false)})`
      case 'form':
        return `__fill_${snake(kind.spec.form)}(__term_data(${value}, ${path}.clone(), ${optional}), ${path})`
      default:
        return '0'
    }
  }

  for (const spec of fills.values()) {
    const known = spec.fields.map(f => JSON.stringify(f.name)).join(', ')
    const fields = spec.fields
      .map(f => `${snake(f.name)}: ${fillOf(f.kind, `find(${JSON.stringify(f.name)})`, `__term_path(&path, ${JSON.stringify(f.name)})`, f.optional)}`)
      .join(', ')

    out.push(
      `fn __fill_${snake(spec.form)}(value: Data, path: String) -> ${pascal(spec.form)} {\n` +
        `    let entries = __term_entries(value, path.clone());\n` +
        `    let known: &[&str] = &[${known}];\n` +
        `    for e in entries.borrow().iter() { if !known.contains(&e.name.as_str()) { __term_mismatch(__term_path(&path, &e.name), "is not in the form".to_string()); } }\n` +
        `    let find = |name: &str| -> Option<Data> { entries.borrow().iter().find(|e| e.name == name).map(|e| e.base.clone()) };\n` +
        `    ${pascal(spec.form)} { ${fields} }\n}`,
    )
  }

  // a field's value, spelled as data. `v` is the value
  const meltOf = (kind: FormKind, value: string): string => {
    switch (kind.kind) {
      case 'text':
        return `Data::Text { value: ${value} }`
      case 'number':
        return `Data::Number { value: ${value} }`
      case 'decimal':
        return `Data::Decimal { value: ${value} }`
      case 'flag':
        return `Data::Flag { value: ${value} }`
      case 'data':
        return value
      case 'list':
        return `Data::Array { list: std::rc::Rc::new(std::cell::RefCell::new((${value}).borrow().iter().map(|x| ${meltOf(kind.item, 'x.clone()')}).collect::<Vec<Data>>())) }`
      case 'form':
        return `__melt_${snake(kind.spec.form)}(${value})`
      default:
        return 'Data::Blank'
    }
  }

  // an optional field left empty is left out
  const emptyTest = (kind: FormKind, value: string): string | undefined => {
    switch (kind.kind) {
      case 'text':
        return `(${value}).is_empty()`
      case 'list':
        return `(${value}).borrow().is_empty()`
      case 'data':
        return `matches!(${value}, Data::Blank)`
      default:
        return undefined
    }
  }

  for (const spec of melts.values()) {
    const lines = spec.fields.map(f => {
      const value = `value.${snake(f.name)}.clone()`
      const entry = `list.push(DataEntry { name: ${JSON.stringify(f.name)}.to_string(), base: ${meltOf(f.kind, value)} });`
      const empty = f.optional ? emptyTest(f.kind, value) : undefined

      return empty ? `    if !${empty} { ${entry} }` : `    ${entry}`
    })

    out.push(
      `fn __melt_${snake(spec.form)}(value: ${pascal(spec.form)}) -> Data {\n    let mut list: Vec<DataEntry> = Vec::new();\n${lines.join('\n')}\n    Data::Hash { list: std::rc::Rc::new(std::cell::RefCell::new(list)) }\n}`,
    )
  }

  return out
}

const RUST_FORM_HELPERS = `fn __term_mismatch(path: String, reason: String) -> ! {
    panic!("{}: {}", "data-mismatch", format!("Data does not fit the shape: {} {}", if path.is_empty() { ".".to_string() } else { path }, reason))
}
fn __term_path(path: &str, key: &str) -> String { if path.is_empty() { key.to_string() } else { format!("{}/{}", path, key) } }
fn __term_kind(value: &Data) -> &'static str {
    match value { Data::Hash { .. } => "a map", Data::Array { .. } => "a list", Data::Blank => "void", Data::Text { .. } => "text", Data::Number { .. } => "number", Data::Decimal { .. } => "decimal", Data::Flag { .. } => "flag", Data::Graft { .. } => "a fuse" }
}
fn __term_entries(value: Data, path: String) -> std::rc::Rc<std::cell::RefCell<Vec<DataEntry>>> {
    match value { Data::Hash { list } => list, other => __term_mismatch(path, format!("is {} where a map belongs", __term_kind(&other))) }
}
fn __term_text(value: Option<Data>, path: String, optional: bool) -> String {
    match value { Some(Data::Text { value }) => value, None | Some(Data::Blank) => if optional { String::new() } else { __term_mismatch(path, "is missing".to_string()) }, Some(other) => __term_mismatch(path, format!("is {} where text belongs", __term_kind(&other))) }
}
fn __term_number(value: Option<Data>, path: String, optional: bool) -> i64 {
    match value { Some(Data::Number { value }) => value, None | Some(Data::Blank) => if optional { 0 } else { __term_mismatch(path, "is missing".to_string()) }, Some(other) => __term_mismatch(path, format!("is {} where number belongs", __term_kind(&other))) }
}
fn __term_decimal(value: Option<Data>, path: String, optional: bool) -> f64 {
    match value { Some(Data::Decimal { value }) => value, Some(Data::Number { value }) => value as f64, None | Some(Data::Blank) => if optional { 0.0 } else { __term_mismatch(path, "is missing".to_string()) }, Some(other) => __term_mismatch(path, format!("is {} where decimal belongs", __term_kind(&other))) }
}
fn __term_flag(value: Option<Data>, path: String, optional: bool) -> bool {
    match value { Some(Data::Flag { value }) => value, None | Some(Data::Blank) => if optional { false } else { __term_mismatch(path, "is missing".to_string()) }, Some(other) => __term_mismatch(path, format!("is {} where flag belongs", __term_kind(&other))) }
}
fn __term_data(value: Option<Data>, path: String, optional: bool) -> Data {
    match value { Some(d) => d, None => if optional { Data::Blank } else { __term_mismatch(path, "is missing".to_string()) } }
}
fn __term_list<T>(value: Option<Data>, path: String, optional: bool, item: &dyn Fn(Data, String) -> T) -> std::rc::Rc<std::cell::RefCell<Vec<T>>> {
    match value {
        Some(Data::Array { list }) => std::rc::Rc::new(std::cell::RefCell::new(list.borrow().iter().enumerate().map(|(i, d)| item(d.clone(), __term_path(&path, &i.to_string()))).collect())),
        None | Some(Data::Blank) => if optional { std::rc::Rc::new(std::cell::RefCell::new(Vec::new())) } else { __term_mismatch(path, "is missing".to_string()) },
        Some(other) => __term_mismatch(path, format!("is {} where a list belongs", __term_kind(&other))),
    }
}`
