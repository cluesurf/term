// The compile-time AST: the records the mills mint, carried through resolution and type checking down to codegen.
// Distinct from the engine AST (the runtime interpreter's): these nodes carry a source span, an optional inferred
// type, and may contain holes (unresolved references). See note/research/vibe/computation/plans/11-elaboration.md.

import type { Span } from '@term/make/code/parser/diagnostic'

// surface types. `unknown` is the gradual any. `variable` is an inference metavariable (a type hole).
export type Type =
  | { kind: 'number' }
  // a 64-bit floating-point number, distinct from the integer `number`. Sources: a decimal literal, `like decimal` /
  // `like float`, the float math library, and JSON numbers. It does not silently unify with the integer `number`.
  | { kind: 'float' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'unit' }
  | { kind: 'unknown'; free?: boolean }
  // the host's dynamic value: a JS `any`, a rust `serde_json::Value`, a swift / kotlin `Any`. The opaque result of
  // `json.parse`, navigated by the json accessors. Distinct from `unknown` (an inference hole that defaults to number).
  | { kind: 'dynamic' }
  // a raw byte buffer backed by the platform's native octet type: a JS `Uint8Array`, a rust `Vec<u8>`, a swift
  // `Data`, a kotlin `ByteArray`. The zero-copy currency for crypto, encoding, file IO, and the network. Hex and
  // base64 are explicit codecs at the edges, not a tax on every call.
  | { kind: 'bytes' }
  | { kind: 'array'; element: Type }
  | { kind: 'map'; key: Type; value: Type }
  // a named type, optionally applied to TYPE arguments (`args`, e.g. `stack natural`) and/or VALUE-INDEX arguments
  // (`valueArgs`, e.g. the `n` in a length-indexed `vec a n`). Value arguments make the type language value-dependent:
  // `vec a zero` and `vec a (succ n)` are DISTINCT types, which is what gives an indexed family its type safety.
  | { kind: 'named'; name: string; args?: Type[]; valueArgs?: Expression[] }
  | {
      kind: 'function'
      params: Type[]
      result: Type
      effects?: string[]
      // the parameters' surface NAMES (positionally aligned with `params`), when written. Lets a DEPENDENT function type
      // resolve a later parameter that mentions an earlier one (`(m) -> lt m n -> acc` -- the second parameter refers to
      // the first, `m`). Absent for an anonymous arrow.
      paramNames?: (string | undefined)[]
    }
  | { kind: 'variable'; id: number }

export const NUMBER: Type = { kind: 'number' }
export const FLOAT: Type = { kind: 'float' }
export const BOOLEAN: Type = { kind: 'boolean' }
export const STRING: Type = { kind: 'string' }
export const UNIT: Type = { kind: 'unit' }
export const UNKNOWN: Type = { kind: 'unknown' }
// a slot the source left EMPTY (a bare `like list`'s element), as opposed to a spelled `like unknown`: the
// checker seeds it as a fresh inference variable, so the concrete element is inferred from usage
export const FREE_UNKNOWN: Type = { kind: 'unknown', free: true }
export const DYNAMIC: Type = { kind: 'dynamic' }
export const BYTES: Type = { kind: 'bytes' }

export type BinaryOp =
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | '&&'
  | '||'
export type UnaryOp = '-' | '!'
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/='

export type Binding =
  | { kind: 'parameter' }
  | { kind: 'local' }
  | { kind: 'function'; arity: number }
  | { kind: 'builtin' }
  | { kind: 'deferred' }

export type Expression =
  | { form: 'integer'; value: number | bigint; span: Span; type?: Type }
  | { form: 'float'; value: number; span: Span; type?: Type }
  | { form: 'boolean'; value: boolean; span: Span; type?: Type }
  | { form: 'string'; value: string; span: Span; type?: Type }
  // runtime text interpolation, `text <a {{x}} b>`: the chunks as written and an expression per `{{...}}`, joined
  // into a text when the program runs (a template literal, `format!`, `"\\(x)"`, `"$x"`). book/language/templates.md.
  | { form: 'template'; parts: (string | Expression)[]; span: Span; type?: Type }
  | { form: 'unit'; span: Span; type?: Type }
  // the host null literal (`null`), for the `dynamic` / host boundary: JSON null, a JS `null` passed to an FFI, the
  // value `is-null` tests for. Distinct from `unit` (void / undefined). Typed `dynamic`; emitted as each host's null.
  | { form: 'null'; span: Span; type?: Type }
  | {
      form: 'variable'
      name: string
      span: Span
      type?: Type
      binding?: Binding
    }
  | {
      form: 'binary'
      op: BinaryOp
      left: Expression
      right: Expression
      span: Span
      type?: Type
    }
  | {
      form: 'unary'
      op: UnaryOp
      operand: Expression
      span: Span
      type?: Type
    }
  | {
      form: 'call'
      callee: Expression
      args: Expression[]
      span: Span
      type?: Type
      // named arguments (`call f / bind a, 200 / bind b, 100`): one entry per arg, the label of a `bind` child or
      // undefined for a positional one. The checker reorders `args` into the callee's declared order and drops this.
      names?: (string | undefined)[]
      // the call was read with the LEAN surface (its file's role carries `mark lean`), and every named argument
      // that came from a property head (`key <tense>`) was built as an ARRAY of that head's children. The checker
      // unwraps a one-item array where the parameter is not a list, by the declared type and never by the count,
      // and drops this beside `names`. Set by the mill; nothing past the checker sees it. See note/term/lean.md.
      lean?: boolean
      // aligned with `names`: true where the label came from a PROPERTY HEAD rather than an explicit `bind`. The
      // checker refuses to drop the first kind on a callee it cannot see, and treats the second as documentation
      // the way it always did, so the stdlib's `call push / bind list, ... / bind item, ...` on a receiver method
      // keeps working under lean.
      leanNames?: boolean[]
      // `wait false`: a fire-and-forget call. It is made but never awaited, even when the callee is async, and it does
      // not make the caller async. Async resolution skips it; without this flag an async call is awaited by default.
      background?: boolean
      // `call fill / <data> / like <form>` and `call melt / <value> / like <form>`: the form a data value fills, or
      // a form value melts back to data. The mill renames the callee to the intrinsic `fill-form` / `melt-form` and
      // puts the form here; the checker types the result from it and the emitter walks the form's fields.
      into?: Type
      // `halt kink`: propagate the callee's error to the caller rather than handling it here (Rust `?`). On the
      // exception-based backends (TypeScript, Kotlin, Swift) this is the default behaviour and needs no emit; on Rust
      // it must emit the `?` operator. Emitters that ignore it are correct only for the former.
      propagate?: boolean
    }
  | { form: 'array'; items: Expression[]; span: Span; type?: Type }
  | {
      form: 'map'
      entries: { key: Expression; value: Expression }[]
      span: Span
      type?: Type
    }
  | {
      form: 'record'
      name: string
      fields: { name: string; value: Expression }[]
      span: Span
      type?: Type
      // positional values (`make point, code 1, code 2`): filled into the form's `slot` fields, in order, by
      // extendForms. A form with no slots refuses them.
      positional?: Expression[]
      // true when no bound value is a function literal (a closure), so the constructed record is pure data and
      // serialises to JSON. The base bridge lifts a function-free record into a `RecordNode`. Computed at mill time.
      functionFree?: boolean
      // read with the lean surface: a field that came from a property head holds an array of that head's
      // children, unwrapped by the checker against the field's declared type. Same contract as a call's `lean`.
      lean?: boolean
    }
  | {
      form: 'member'
      target: Expression
      name: string
      // a DYNAMIC segment: `read table/{key}` reads the member named by evaluating `key` at runtime, rather than the
      // literal member `key`. When set, `name` is the source text of the segment (kept for diagnostics) and emitters
      // must render a subscript rather than a dot access.
      index?: Expression
      // the member's foreign `name <...>` (e.g. a binding field's `COLOR_BUFFER_BIT`), set by the checker when the
      // accessed field declares one, so the emitter uses the exact native name instead of camelCasing the seed name.
      nick?: string
      span: Span
      type?: Type
    }
  // await an async result (`call ... / wait true`)
  | { form: 'await'; expr: Expression; span: Span; type?: Type }
  // a function literal / callback value (`task name / take ... / <body>` used as a value), e.g. a hook handler
  | {
      form: 'closure'
      params: { name: string; type?: Type }[]
      body: Statement[]
      result?: Type
      async?: boolean
      span: Span
      type?: Type
    }
  // a conditional in value position (`save x / fork test / hook test <cond> / hook hold <value> / hook miss <else>`):
  // each branch is a (cond, value) pair, with an optional final `otherwise`. Emits as a ternary chain.
  | {
      form: 'conditional'
      branches: { cond: Expression; value: Expression }[]
      otherwise?: Expression
      span: Span
      type?: Type
    }
  // a hole: an unresolved reference, may be runtime-deferred
  | {
      form: 'hole'
      name: string
      span: Span
      type?: Type
      deferred?: boolean
    }

// what a checker-written `hold` stands for. The contract kinds fail the build when unproven, because a programmer
// wrote them. The tier-0 kinds are counted against a baseline, because nobody did. note/term/proof-by-default/.
export type HoldOrigin =
  // contracts
  | 'must' // a task's postcondition, at one `send back`
  | 'need' // a callee's `have`, at one call
  | 'keep-entry' // a walk's invariant, on entry
  | 'keep-turn' // a walk's invariant, at the end of a turn
  | 'down' // a walk's measure falls, and stays a natural number
  // tier 0
  | 'index' // a list read inside its bounds
  | 'zero' // a division or remainder by something other than zero
  | 'ends' // a walk with no `down` ends: a measure inferred from its condition stays natural and falls
  // not owed at all
  | 'given' // a callee's `must`, ASSUMED after the call: proven where the callee is checked, so nothing to prove here

export type Statement =
  // `foreign` is the host name an ambient binding maps to (`host document, name <document>`): a value-less `host`
  // with a foreign name is a host global, emitted as an alias to that global (or nothing when the names match)
  // rather than `const x = undefined`.
  | {
      form: 'let'
      name: string
      init: Expression
      mutable: boolean
      span: Span
      type?: Type
      foreign?: string
    }
  | {
      form: 'assign'
      target: Expression
      op: AssignOp
      value: Expression
      span: Span
    }
  | { form: 'expression'; expr: Expression; span: Span }
  | {
      form: 'if'
      branches: { cond: Expression; body: Statement[] }[]
      otherwise?: Statement[]
      span: Span
    }
  | {
      form: 'while'
      cond: Expression
      body: Statement[]
      span: Span
      // the walk's contract: invariants true on entry and at the end of every turn, and a measure that falls on
      // every turn. Read only by the checker (check/contract.ts); every backend ignores them.
      must?: Expression[]
      down?: Expression
    }
  // a pattern match on an enum value (fork case): each case is a variant label, with optional `binds` renaming the
  // variant's fields (in declaration order) so a nested match on the same enum can name both without collision
  | {
      form: 'match'
      subject: Expression
      cases: { label: string; body: Statement[]; binds?: string[] }[]
      otherwise?: Statement[]
      span: Span
      // filled by the checker when the subject is a caught exception and the labels are exception forms: per label,
      // the shared fields the arm binds off the carrier and the props it binds off the form's `link` record, so every
      // backend lowers the arm the same way (`form` is the discriminant). note/term/hive/11-native-exceptions.md
      exceptionArms?: Record<string, { shared: string[]; link: string[] }>
      // FILLED BY THE CHECKER WHEN THE ARMS COVER EVERY VARIANT and there is no `otherwise`. The checker
      // already works this out to report `non-exhaustive`; saying so on the node lets a backend close the
      // chain with a plain `else` instead of a last `if`, which is what a host's own return analysis needs
      // in order to see that a task whose arms all return cannot fall out of the bottom.
      closed?: boolean
    }
  | {
      form: 'for-each'
      item: string
      // a SECOND `take` binds the turn's index. Without it a walk could not name its own position at all, and
      // the answer was a `save` counter beside the loop. lean-0017
      index?: string
      iterable: Expression
      body: Statement[]
      span: Span
      // the walk's invariants (see `while`). A walk over a list ends by itself, so it takes no measure.
      must?: Expression[]
    }
  | { form: 'break'; span: Span }
  | { form: 'continue'; span: Span }
  | { form: 'return'; value?: Expression; span: Span }
  // stop the whole program (`halt flow`), lowered to each host's process exit
  | { form: 'exit'; span: Span }
  // a debugger breakpoint (`halt code`)
  | { form: 'debug'; span: Span }
  // a guarded body (`note unsafe` over statements) with its handler (`halt take` / `take <name>` / body): the
  // exceptions the body raises are caught and bound to `name` in the handler. Lowers to try / catch. The
  // handler is optional only while a program is being written; a guard without one re-raises nothing and catches
  // everything, which the checker warns about.
  | {
      form: 'guard'
      body: Statement[]
      catch?: { name: string; body: Statement[]; span: Span }
      span: Span
    }
  // throw an error value. `halt <form>` with `bind` children raises a declared exception: `value` is the record as
  // written and `raise` names the form, so `extendForms` can check the form is an exception, refuse a pinned field,
  // wrap the props into the `link` record and fill `host` / `form` / `code` / `time`. A bare `halt <text>` (and the
  // retired `bust`) throws its value as-is with no `raise`.
  | { form: 'throw'; value: Expression; span: Span; raise?: string }
  // a verification condition: the expression must be provably true (refinement layer 2). An optional `name` makes
  // it a citable lemma; an optional `proof` is the explicit proof tree (heads from hold/base/terms.json).
  | {
      form: 'hold'
      expr: Expression
      name?: string
      proof?: Proof[]
      span: Span
      // set on a hold the CHECKER wrote rather than the programmer: which contract or which tier-0 obligation it
      // stands for, so a failure says what was owed. Only in the checker's own copy of the program
      // (check/contract.ts), never in the program a backend emits.
      origin?: HoldOrigin
    }
  // a `method` tag marks a function desugared from a form's nested `task`: its `name` is mangled (`<form>_<method>`)
  // to avoid cross-module clashes, and `method` records the form and the bare method name for receiver dispatch.
  | {
      form: 'function'
      name: string
      params: {
        name: string
        type?: Type
        refine?: 'natural'
        optional?: boolean
        // `fall <value>`: the value an omitted argument gets, cloned into the call by the checker
        fallback?: Expression
        // `slot <name>` instead of `take <name>`: positional only, refused as a named argument
        positional?: boolean
        // `like u8` and the other width aliases: the parameter is a `number`, and a literal argument outside the width
        // is refused (check/literals.ts). Wider checking needs range types
        width?: string
      }[]
      body: Statement[]
      result?: Type
      generics: { name: string; need?: string }[]
      async?: boolean
      // `mark private`: the definition is visible only inside the file that defines it. A reference from any other
      // file is refused as `private-name` (check/private.ts). Also lets dead-code detection flag an unreferenced
      // private function as truly dead (a public one might be called from outside this compilation).
      private?: boolean
      // set by compileProgram on a function OUTSIDE the compiled unit's public surface (its `roots`): nothing outside
      // the program can call it, so every call it receives is in the program. Absent means it may be called from
      // outside, which is the safe reading. The interval fact reads a parameter of one as the hull of its arguments
      // (ir/facts/interval.ts)
      internal?: boolean
      // where the old spelling, `note private`, was written: still honored, and warned about (`note-private`)
      privateNote?: Span
      // separate compilation: a signature-only declaration standing in for a function another unit defines. Its body
      // is empty and is neither checked nor emitted; dependents type-check against stubs instead of dependency
      // bodies, so a body-only edit in a dependency never re-checks its dependents. See code/compile/stub.ts.
      stub?: boolean
      // a `rule` written as a SIGNATURE (`head` / `take` / `like`, no `show` goal): a CLAIM. It declares a name at
      // a type and owes a proof, which is a `task` of the same name. Until that task exists the name is declared
      // and not defined: `open-claim` refuses the book, and `open-claim-used` refuses code that calls it. `open`
      // is `note open` on the rule, which keeps the claim deliberately open (counted and reported, not fatal).
      // See note/term/project/law-proof-gate.md.
      claim?: boolean
      open?: boolean
      // set by the claim check on a task the kernel checked as one term, that terminates, is pure, and calls only
      // tasks that are grounded in turn. A stub carries it from its owning unit, which is the only way a dependent
      // unit can know a lemma it calls is proven rather than merely typed. See check/claim.ts groundingOf.
      grounded?: boolean
      // a `rule` with `base true`: its goal is POSTULATED, not proven. Listed by name in the trust ledger.
      axiom?: boolean
      // a `rule` with a `show` goal: a THEOREM over its `mark`s. A mark of task type is then a quantified
      // mathematical function, so the provers read a call of it as a pure application (check/holds.ts `applied`)
      theorem?: boolean
      // a theorem's hypotheses that bind variables of their own (`have h / mark m / <proposition>`): each holds for
      // every value of its binders, and the prover instantiates it where the goal needs it
      universals?: { name: string; binders: string[]; expr: Expression }[]
      // `note roam`: the task is MEANT to run forever (a server, an event loop). Its walks owe no termination, it is
      // never a function (so no proof or claim may use it), and the trust ledger lists it. proof-by-default-0035
      roam?: boolean
      // `mark deprecated`: a call to the task from another file is warned about (check/deprecated.ts)
      deprecated?: boolean
      method?: { form: string; name: string }
      // `halt <form>` lines with no children on the signature: the exceptions the task declares it can raise. Absent
      // means inferred. Present means checked: the inferred raise set must be a subset (03-exception.md, bounding).
      raises?: string[]
      // the task's contract: `have` lines (preconditions the body assumes and every caller proves), `must` lines
      // (postconditions over `read back`, proven at every `send back`), and `down` (a measure for a recursive task).
      // Read only by the checker (check/contract.ts); every backend ignores them.
      have?: Expression[]
      must?: Expression[]
      down?: Expression
      // the parameter and result types AS WRITTEN, snapshotted before the surface checker seeds them. Seeding is
      // lossy on purpose (a form gets only as many type arguments as it declares, and a name it does not know becomes
      // an inference variable), which is right for inference and for every backend and wrong for the kernel: it made
      // `equal a x y` read as `equal a`, so a claim about which two values are equal was checked as a claim about
      // nothing (proof-by-default-0031). The kernel reads these where seeding lost something.
      declared?: { params: (Type | undefined)[]; result?: Type }
      span: Span
    }
  | {
      form: 'record-type'
      name: string
      params: string[]
      // VALUE indices: relevant value parameters of the type former (`head n, like natural-number`), making this an
      // indexed family `T <params> <indices>`. Each variant supplies its output index in `indexValues`.
      indices?: { name: string; type: Type }[]
      // `identity` marks the field declared with `note id`: the field whose value is the record's durable identity
      // (its mark), so the base bridge maps it to a `mark` constraint and re-compiling the same source is idempotent.
      // `optional` is `need false` (the field may be absent), `fallback` is `fall <value>` (the value a construction
      // that omits the field gets). Both are read at a `make` / `halt <form>` by extendForms.
      fields: {
        name: string
        type: Type
        nick?: string
        identity?: boolean
        optional?: boolean
        fallback?: Expression
        // `slot <name>` instead of `link <name>`: fillable by position at a `make`, in declaration order
        positional?: boolean
      }[]
      variants: {
        name: string
        fields: { name: string; type: Type; nick?: string; identity?: boolean }[]
        // the output index expressions of this constructor (one per declared index, in order): `vnil` outputs `zero`,
        // `vcons` outputs `succ count`. Present only on an indexed family; the constructor's result type is
        // `T <params> <indexValues>`.
        indexValues?: Expression[]
      }[]
      // the `like <type>` base of a transparent alias form (`form g-luint, like native-number`): a form with this base
      // and no fields/variants is an alias that unifies with its base. Undefined for ordinary forms.
      alias?: Type
      // `mark tag, name kind`: the field a union's TypeScript type and values discriminate on. Absent means `form`.
      // TypeScript only: the native backends emit enums (self-hosting-0020)
      tag?: string
      // `like <base>` WITH children: the form EXTENDS `base`. `head` children name type arguments (`head a, like
      // text`, or `head a` over `link` lines for an anonymous record), `bind` children PIN fields of the base (fixed by
      // this type, refused at a construction), and `link` children add props to the base's record parameter. Resolved
      // into plain `fields`, `pins`, `chain` and `props` by `extendForms` (check/extend.ts) before resolution, so every
      // later pass sees an ordinary record. See note/term/hive/03-exception.md.
      extend?: {
        base: Type
        heads: {
          name: string
          type?: Type
          links?: { name: string; type: Type }[]
          span: Span
        }[]
        links: {
          name: string
          type: Type
          nick?: string
          identity?: boolean
          optional?: boolean
          fallback?: Expression
        }[]
        pins: { name: string; value: Expression }[]
        span: Span
      }
      // filled by extendForms: the fields this type fixes (inherited and own, later pins winning), in declaration order
      pins?: { name: string; value: Expression }[]
      // filled by extendForms: the base chain, root first (`exception`, `excess` for `upload-excess`)
      chain?: string[]
      // filled by extendForms: the name of the synthesized props record (`upload-excess-link`), when the chain's root
      // takes a record parameter that this form's `link` lines extend
      props?: string
      // a PROPOSITIONAL TRUNCATION (hProp): declared with `mark prop`, any two inhabitants are equal (proof
      // irrelevance). Its constructors are kept rigid (no reduction) and registered so `convert` equates them.
      truncation?: boolean
      // `mark shared`: a value of this form is ONE object, seen and written through every binding of it, as a signal
      // or an effect in a reactive graph must be. A backend whose forms are values (Swift's `struct`) emits a reference
      // type instead; one whose forms are references already (TypeScript, Kotlin) emits what it always does. Absent
      // means a plain value form. See note/term/app/10-native-dom.md.
      shared?: boolean
      // true when no field's type is a function, so instances are pure data (a base `RecordNode` / JSON). The base
      // bridge lifts only function-free forms into records; a form with a function-typed field stays code.
      functionFree?: boolean
      span: Span
    }
  // a trait: a named set of method signatures (mask)
  | { form: 'mask'; name: string; methods: string[]; span: Span }
  // a trait implementation for a type: provides methods (wear on a form, or suit standalone)
  | {
      form: 'instance'
      mask: string
      target: string
      methods: string[]
      span: Span
    }
  // a native module binding (`dock load / load <node:fs/promises>, name fs`): the env-specific FFI for the stdlib.
  // `file` is the module this dock lives in, so a `<global:X>` runtime shim can be found next to it (`./runtime/X.ext`).
  | {
      form: 'native'
      alias: string
      module: string
      // `'type'` marks an opaque per-backend handle type (`dock type / load <tokio::net::TcpStream>, name tcp-handle`):
      // `module` holds the concrete native type, `alias` the seed-side name. A backend resolves the seed name to the
      // concrete string in its type emitter and never emits an import for it. Absent / `'module'` is the ordinary FFI
      // module binding (`dock load`).
      kind?: 'module' | 'type'
      span: Span
      file?: string
    }
  // a declarative native binding: one stdlib name, a per-environment native expression template. A `$param` placeholder
  // in a target's expression is substituted with the emitted argument at each call site. The verb that dispatches to a
  // bind folds away under specialization, leaving the bind call to render its env's template (e.g. `Math.log2(x)` on
  // node, `x.log2()` on rust). See note/research/vibe/computation/plans/20-specialization-and-bind.md.
  | {
      form: 'bind'
      name: string
      params: {
        name: string
        type?: Type
        refine?: 'natural'
        optional?: boolean
      }[]
      result?: Type
      targets: {
        env: string
        expression: string
        imports: { module: string; alias?: string }[]
      }[]
      span: Span
    }
  // a component (view) definition, lowered from the `zone` DSL (book/site navigation, state, forms)
  | {
      form: 'view'
      name: string
      params: { name: string; type?: Type }[]
      body: ViewNode[]
      span: Span
    }
  // a routing / CLI dock, lowered from the `dock` DSL (book/site/routes, navigation; book/line/calls)
  | { form: 'dock'; route: DockRoute; span: Span }
  // a kind a deck declares (`roll metric` / `like metric`): every top-level `host` constant of that form in the build
  // is an entry on the roll under the kind's name, woken into the hive at boot. See note/term/hive/07-kind.md.
  | { form: 'roll'; name: string; like: string; span: Span }
  // the app's decision about one exception (`tell @deck/form` with `note`, `hint`, `link`, `name`): what a customer
  // may be told. Absent means private. Checked against the reachable exceptions, carried on the roll, emits nothing.
  // See note/term/hive/06-tell.md.
  | {
      form: 'tell'
      name: string
      note?: string
      hint?: string
      links: string[]
      alias?: string
      span: Span
    }

// ---- the zone (component / view) AST ----
// an attribute or event binding on an element: `seed class, read theme` (attribute) or `seed click, call add` (event)
export type ViewAttribute = {
  name: string
  value: Expression
  event: boolean
  span: Span
}
export type ViewNode =
  // `view div` / `view counter`: an html element or nested component. `props` are component inputs (`bind id, ...`).
  | {
      form: 'element'
      name: string
      attributes: ViewAttribute[]
      props: { name: string; value: Expression }[]
      children: ViewNode[]
      // an optional ref: `view input / name title-field` binds the built element to `title-field`, a `view`-typed local
      // the rest of the zone (e.g. an event handler) can read
      ref?: string
      // `node <tag>` (vs `view <tag>`) forces an html element even when `<tag>` is also a component name. The escape
      // hatch for rendering a real `<select>` / `<dialog>` / etc. inside a component of the same name (e.g. native-select).
      forced?: boolean
      span: Span
    }
  | { form: 'text'; value: string; span: Span }
  // a dynamic value rendered inline: `read app/count`
  | { form: 'read'; value: Expression; span: Span }
  // the outlet for children / the active child route
  | { form: 'slot'; name?: string; span: Span }
  // a conditional render: `fork test` with `hook test` / `hook hold` / `hook miss`
  | {
      form: 'fork'
      branches: { cond: Expression; body: ViewNode[] }[]
      otherwise?: ViewNode[]
      span: Span
    }
  // a list render: `walk list, read items` / `hook next` / `take site, name item`
  | {
      form: 'walk'
      iterable: Expression
      item: string
      body: ViewNode[]
      span: Span
    }
  // a computed local: `save total / call count, ...`
  | { form: 'save'; name: string; value: Expression; span: Span }
  // a setup statement run for its effect while the component builds: `call on-mount / task start / ...`, `call
  // make-effect`, `call on-cleanup`. Evaluated in source order among the non-`save` body nodes, so it sees the
  // elements declared above it. Without this a component could only declare state and markup, and a `call` in a
  // component body was dropped without a word.
  | { form: 'call'; value: Expression; span: Span }

// ---- the dock (routing / CLI) AST ----
export type DockArgument = { name: string; value: Expression }
export type DockCall = {
  name: string
  args: DockArgument[]
  // the bound task's parameter names, in its own order, so a command passes each take to the parameter of its name.
  // Filled by `commandRoutes` from the program (call/code/hook-dispatch.ts)
  params?: string[]
  span: Span
}
export type DockTake = {
  name: string
  type?: Type
  required: boolean
  // a CLI short flag: `take title / code t` makes `--title` also available as `-t`
  short?: string
  // masked input (a password / secret): `take code / wait rise` reads without echoing
  masked?: boolean
  // help text for --help: `take glob / note <Directory to hunt>`
  note?: string
  // a default value: `take runs, like number / bind 3000`. The literal as written.
  fallback?: string | number | boolean
  // a variadic / rest positional: `take paths / many` collects the remaining positionals
  variadic?: boolean
  // an allowed-value set (enum / choices): `take tool / pick <trivy> / pick <grype>`
  choices?: string[]
  span: Span
}
export type DockMethod = {
  name: string
  takes: DockTake[]
  calls: DockCall[]
  sends: { name: string; value?: Expression }[]
  span: Span
}
export type DockRoute = {
  // a route path (`/users/:id`) or a CLI command name (`make`)
  path: string
  // help text for --help: `hook hunt / note <Automated bug-hunt>`
  note?: string
  takes: DockTake[]
  methods: DockMethod[]
  calls: DockCall[]
  // a client route renders a component: `view user-detail / bind id, read id`
  component?: { name: string; props: DockArgument[] }
  directives: { name: string; value?: Expression }[]
  sends: { name: string; value?: Expression }[]
  hooks: { name: string; calls: DockCall[] }[]
  children: DockRoute[]
  span: Span
}

// a node in an explicit proof tree: a four-letter tactic `head` paired with an optional one-word `arg`, plus
// nested sub-proofs. See note/research/vibe/computation/libraries/06-hold.md.
export type Proof = {
  head: string
  arg?: string
  children: Proof[]
  span: Span
}

export type Program = Statement[]

// Another implementation of a named task, read from a `twin` declaration (note/term/optimize/words.md). It is NOT a
// statement: the mill returns twins BESIDE the program, so every pass and every backend that does not choose between
// implementations never sees one and emits the reference, which is always a correct choice.
export type Twin = {
  // the task this is another implementation of, as written (an alias is resolved later, like any reference)
  of: string
  // its label among that task's twins: what bake.json, `term race` and `term bake --why` print
  name: string
  // the parameters by name, in the reference's order. Their types, the generics and the result come from the task
  params: string[]
  // conditions the compiler must PROVE at a call site for the twin to be eligible there
  have: Expression[]
  // `hook test`: conditions proven where they can be, and checked at run time where they cannot
  test: Expression[]
  // relaxations of the meaning the twin needs (`float-order`, `float-fused`), granted by the caller's `note ease`
  ease: string[]
  // an estimate of the work over the input sizes, used only for a static choice
  cost?: Expression
  // knobs: compile-time values a `tour` chooses
  knobs: { name: string; type?: Type }[]
  // the targets it is eligible on (`mark platform, name rust`); empty is every target
  platform: string[]
  // `mark trust`: admitted as trusted, so it may call native code the kernel cannot see
  trust: boolean
  body: Statement[]
  span: Span
}

// A type as a person reads it, in Term's own words: `text`, `void`, `list, like number`, `hash, like text, like
// number`. Every diagnostic, `term roll`, `term look` and the language server print through this. It printed the
// checker's internal names until 2026-10-04 (`string`, `unit`, `number[]`, `map<string, number>`), which a reader
// had to translate back into what they wrote (guides: types, basics/tour, commands/roll).
//
// A type argument the checker has not solved is left off, the way `like list` with nothing after it leaves the
// element open, so a list built in the call itself prints `list`, not `?2[]`. Alone it is `an unsolved type`.
export function showType(type: Type): string {
  return type.kind === 'variable' ? 'an unsolved type' : spell(type)
}

// one type in a `like` chain. A compound argument inside a task's parentheses is wrapped again, so its commas
// cannot be read as the task's
function spell(type: Type): string {
  switch (type.kind) {
    case 'string':
      return 'text'
    case 'unit':
      return 'void'
    case 'array':
      return chain('list', [type.element])
    case 'map':
      return chain('hash', [type.key, type.value])
    case 'named':
      return chain(type.name, type.args ?? [])
    case 'function': {
      const params = type.params.map(p => {
        const written = spell(p)

        return written.includes(',') ? `(${written})` : written
      })
      const effects =
        type.effects && type.effects.length > 0
          ? ` !${type.effects.join(',')}`
          : ''

      return `task(${params.join(', ')}) -> ${spell(type.result)}${effects}`
    }
    case 'variable':
      return 'unknown'
    default:
      return typeKey(type)
  }
}

// `list, like text`: the head, then each SOLVED argument after a `like`
function chain(head: string, args: Type[]): string {
  const solved = args.every(a => a.kind !== 'variable') ? args : []

  return [head, ...solved.map(a => `like ${spell(a)}`)].join(', ')
}

// A type as a KEY: exact and structural, so two types print alike only when they are alike. An unsolved variable
// keeps its number here (`?3[]` and `?7[]` are two lists), which is what an overload's shape compares
// (check/overload.ts). Never shown to a person: that is showType.
export function typeKey(type: Type): string {
  switch (type.kind) {
    case 'number':
      return 'number'
    case 'float':
      return 'float'
    case 'dynamic':
      return 'dynamic'
    case 'bytes':
      return 'bytes'
    case 'boolean':
      return 'boolean'
    case 'string':
      return 'string'
    case 'unit':
      return 'unit'
    case 'unknown':
      return 'unknown'
    case 'array':
      return `${typeKey(type.element)}[]`
    case 'map':
      return `map<${typeKey(type.key)}, ${typeKey(type.value)}>`
    case 'named':
      return type.args && type.args.length > 0
        ? `${type.name}<${type.args.map(typeKey).join(', ')}>`
        : type.name

    case 'function': {
      const effects =
        type.effects && type.effects.length > 0
          ? ` !${type.effects.join(',')}`
          : ''

      return `(${type.params.map(typeKey).join(', ')}) -> ${typeKey(
        type.result,
      )}${effects}`
    }

    case 'variable':
      return `?${type.id}`
  }
}
