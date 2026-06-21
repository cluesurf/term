// Incremental compiler front-end on the query engine (Tier 2). Source text is an input; parse and mill are memoized
// queries that track their dependencies automatically. Editing one module re-parses and re-mills only that module.
// Crucially, mill backdates (an edit that changes the source but not the milled AST, e.g. a comment, leaves the merged
// program and everything downstream untouched). This is the first phase wired onto the engine; resolve / check / emit
// follow as per-definition queries with the signature firewall. See note/seed/plan/compilation-performance.md (Tier 2).

import { parse } from '@cluesurf/make/code/parser/tree'
import { expandTemplates } from '@cluesurf/make/code/compile/template'
import type { Template } from '@cluesurf/make/code/compile/template'
import { mill } from '@cluesurf/make/code/compile/mill'
import { Database, LOW } from '@cluesurf/make/code/compile/query'
import type { Durability, Cx } from '@cluesurf/make/code/compile/query'
import { hashText } from '@cluesurf/make/code/compile/cache'
import type { MilledUnit } from '@cluesurf/make/code/compile/cache'
import type {
  Program,
  Statement,
  Expression,
} from '@cluesurf/make/code/compile/node'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import {
  resolve as resolveNames,
  buildGlobalScope,
} from '@cluesurf/make/code/check/resolve'
import type { Scope } from '@cluesurf/make/code/check/resolve'
import { check as inferTypes } from '@cluesurf/make/code/check/infer'
import { emitTypeScript } from '@cluesurf/make/code/compile/typescript'

export type MergedProgram =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Diagnostic[] }

// two milled programs are equal when their STRUCTURE is, ignoring spans. A comment-only or reformatting edit shifts
// every span but changes no AST, so it must backdate (leave dependents green). Spans are provenance for diagnostics,
// carried beside the value, never compared as a dependency target (the Salsa rule).
function withoutSpans(_key: string, value: unknown): unknown {
  return _key === 'span' ? undefined : value
}

function milledEquals(a: MilledUnit, b: MilledUnit): boolean {
  return (
    hashText(JSON.stringify(a, withoutSpans)) ===
    hashText(JSON.stringify(b, withoutSpans))
  )
}

export class QueryCompiler {
  readonly db = new Database()

  // set or change a module's source. The edited buffer is LOW durability, the stdlib HIGH (so a keystroke validates
  // stdlib-derived queries in O(1)).
  setSource(
    file: string,
    text: string,
    durability: Durability = LOW,
  ): void {
    this.db.setInput(`source:${file}`, text, durability)
  }

  // the parse tree of a module (a query over its source)
  private parsed(
    cx: Cx,
    file: string,
  ): Promise<ReturnType<typeof parse>> {
    return cx.query(`parse:${file}`, c =>
      parse({ file, text: c.input<string>(`source:${file}`) }),
    )
  }

  // the milled program of a module (a query over its parse). Backdated by structural equality.
  milled(
    cx: Cx,
    file: string,
    templates?: Map<string, Template>,
  ): Promise<MilledUnit> {
    return cx.query(
      `mill:${file}`,
      async c => {
        const parsed = await this.parsed(c, file)

        if (!parsed.ok) {
          return { ok: false, diagnostics: parsed.diagnostics }
        }

        return mill(expandTemplates(parsed.tree, templates), file)
      },
      milledEquals,
    )
  }

  // the merged program over a set of modules (a query depending on each module's mill). Recomputes only when some
  // module's milled output actually changed, not merely its source text.
  program(cx: Cx, files: string[]): Promise<MergedProgram> {
    return cx.query(`program:${files.join('|')}`, async c => {
      const program: Program = []

      for (const file of files) {
        const unit = await this.milled(c, file)

        if (!unit.ok) {
          return { ok: false, diagnostics: unit.diagnostics }
        }

        program.push(...unit.program)
      }

      return { ok: true, program }
    })
  }

  // ---- the per-definition layer (the signature firewall) ----
  // The downstream phases are keyed per definition. The whole-program `program` query recomputes on any real edit, but
  // each per-definition query backdates to its own slice, so a body edit invalidates only that definition's body
  // check, never its callers (which depend on its SIGNATURE, not its body). This is the Salsa firewall on real defs.

  private async functions(
    cx: Cx,
    files: string[],
  ): Promise<Map<string, FunctionDef>> {
    const merged = await this.program(cx, files)

    return merged.ok ? functionDefs(merged.program) : new Map()
  }

  // the set of defined function names. Backdates while the set is unchanged (so a body / signature edit, which does
  // not add or remove a name, does not invalidate dependents that only ask "what names exist").
  defNames(cx: Cx, files: string[]): Promise<string[]> {
    return cx.query(
      'defNames',
      async c => [...(await this.functions(c, files)).keys()].sort(),
      (a, b) => a.join(',') === b.join(','),
    )
  }

  // a definition's SIGNATURE (params + result, span-free). The firewall boundary: callers depend on this. Backdates
  // when only the body changes, so a body edit never advances it.
  signature(cx: Cx, files: string[], name: string): Promise<string> {
    return cx.query(`signature:${name}`, async c => {
      const fn = (await this.functions(c, files)).get(name)

      return fn
        ? structureKey({
            params: fn.params.map(p => p.type),
            result: fn.result,
          })
        : ''
    })
  }

  // a definition's body fingerprint + the function names it calls. Backdates when the body is structurally unchanged.
  bodyRefs(
    cx: Cx,
    files: string[],
    name: string,
  ): Promise<{ bodyKey: string; refs: string[] }> {
    return cx.query(
      `bodyRefs:${name}`,
      async c => {
        const fn = (await this.functions(c, files)).get(name)

        if (!fn) {
          return { bodyKey: '', refs: [] }
        }

        return {
          bodyKey: structureKey(fn.body),
          refs: [...collectCallRefs(fn.body)].sort(),
        }
      },
      (a, b) =>
        a.bodyKey === b.bodyKey &&
        a.refs.join(',') === b.refs.join(','),
    )
  }

  // check one definition: every function it calls must be defined or a builtin. Depends on its own body + refs, the
  // name set, and each defined callee's SIGNATURE (never the callee's body). So editing a callee body leaves this
  // green; editing a callee signature re-checks it.
  checkDef(
    cx: Cx,
    files: string[],
    name: string,
  ): Promise<{ name: string; unresolved: string[] }> {
    return cx.query(
      `checkDef:${name}`,
      async c => {
        const { refs } = await this.bodyRefs(c, files, name)
        const defined = new Set(await this.defNames(c, files))
        const unresolved: string[] = []

        for (const ref of refs) {
          if (defined.has(ref)) {
            await this.signature(c, files, ref) // the firewall dependency: the callee's signature
          } else if (!BUILTINS.has(ref)) {
            unresolved.push(ref)
          }
        }

        return { name, unresolved }
      },
      (a, b) => a.unresolved.join(',') === b.unresolved.join(','),
    )
  }

  // ---- the functional per-definition pipeline (real resolve; stage 1) ----

  // the merged program (or empty on a compile error)
  private async merged(cx: Cx, files: string[]): Promise<Program> {
    const result = await this.program(cx, files)

    return result.ok ? result.program : []
  }

  // the global name scope (names -> kind/arity + intrinsics), built once. Backdates while the name set + arities are
  // unchanged, so editing a body does not invalidate it.
  nameIndex(cx: Cx, files: string[]): Promise<Scope> {
    return cx.query(
      'nameIndex',
      async c => buildGlobalScope(await this.merged(c, files)),
      (a, b) => scopeKey(a) === scopeKey(b),
    )
  }

  // one function's raw (unresolved) definition, sliced from the merged program. Backdates per function (span-free).
  functionSource(
    cx: Cx,
    files: string[],
    name: string,
  ): Promise<FunctionDef | undefined> {
    return cx.query(
      `source:${name}`,
      async c => functionDefs(await this.merged(c, files)).get(name),
      (a, b) => structureKey(a) === structureKey(b),
    )
  }

  // resolve one function's body against the global scope, functionally (on a clone, so the result is a stable cached
  // value). Depends only on this function's source + the name index, so editing a sibling does not re-resolve it.
  resolvedDef(
    cx: Cx,
    files: string[],
    name: string,
  ): Promise<{
    def: FunctionDef | undefined
    diagnostics: Diagnostic[]
  }> {
    return cx.query(
      `resolved:${name}`,
      async c => {
        const source = await this.functionSource(c, files, name)

        if (!source) {
          return { def: undefined, diagnostics: [] }
        }

        const scope = await this.nameIndex(c, files)
        const clone = structuredClone(source)
        const diagnostics = resolveNames(
          [clone],
          '<entry>',
          undefined,
          {
            scope,
            only: name,
          },
        )

        return { def: clone, diagnostics }
      },
      (a, b) =>
        structureKey(a.def) === structureKey(b.def) &&
        a.diagnostics.length === b.diagnostics.length,
    )
  }

  // the type-checking context: the program with every function BODY stripped. Infer only needs other definitions'
  // signatures + the forms / enums, never their bodies, so this backdates on a body edit. That is what lets a
  // function be type-checked without depending on its siblings' bodies (the firewall, on real inference).
  private signatureContext(cx: Cx, files: string[]): Promise<Program> {
    return cx.query(
      'signatureContext',
      async c =>
        (await this.merged(c, files)).map(statement =>
          statement.form === 'function'
            ? { ...statement, body: [] }
            : statement,
        ),
      (a, b) => structureKey(a) === structureKey(b),
    )
  }

  // type-check one function functionally: infer its resolved clone against the signature context (other definitions'
  // signatures + the forms), checking only that function's body. Depends on its own resolved body, each defined
  // callee's signature, and the signature context -- none of which a sibling's body edit changes. So a callee body
  // edit does not re-type-check this function. The typed clone is the stable cached value.
  typedDef(
    cx: Cx,
    files: string[],
    name: string,
  ): Promise<{
    def: FunctionDef | undefined
    diagnostics: Diagnostic[]
  }> {
    return cx.query(
      `typed:${name}`,
      async c => {
        const resolved = await this.resolvedDef(c, files, name)

        if (!resolved.def) {
          return { def: undefined, diagnostics: [] }
        }

        // firewall: depend on each defined callee's signature, never its body
        const defined = new Set(await this.defNames(c, files))

        for (const ref of collectCallRefs(resolved.def.body)) {
          if (defined.has(ref)) {
            await this.signature(c, files, ref)
          }
        }

        // the context is bodies-stripped declarations; swap in this function's real resolved body, check only it
        const clone = resolved.def
        const program = (await this.signatureContext(c, files)).map(
          s => (s.form === 'function' && s.name === name ? clone : s),
        )

        const diagnostics = inferTypes(
          program,
          '<entry>',
          undefined,
          name,
        )

        return { def: clone, diagnostics }
      },
      (a, b) =>
        structureKey(a.def) === structureKey(b.def) &&
        a.diagnostics.length === b.diagnostics.length,
    )
  }

  // ---- per-definition emit (stage 3) ----

  // emit one function's TypeScript from its typed clone. Depends on `typedDef(name)`, which backdates when the
  // function is unchanged, so editing a sibling never re-emits this one (the emit-level firewall).
  emitDef(cx: Cx, files: string[], name: string): Promise<string> {
    return cx.query(`emit:${name}`, async c => {
      const typed = await this.typedDef(c, files, name)

      return typed.def ? emitTypeScript([typed.def]) : ''
    })
  }

  // the whole program's TypeScript, assembled from the per-definition emits plus the non-function statements (forms,
  // native docks). A one-function edit re-emits only that function.
  emitProgram(cx: Cx, files: string[]): Promise<string> {
    return cx.query(`emit`, async c => {
      const program = await this.merged(c, files)
      const parts: string[] = []
      const others = program.filter(s => s.form !== 'function')

      if (others.length) {
        parts.push(emitTypeScript(others))
      }

      // per-definition emit runs concurrently: each `emitDef` is independent (its own resolve -> infer -> emit chain)
      const functionNames = program
        .filter(s => s.form === 'function')
        .map(s => (s).name)

      const emitted = await Promise.all(
        functionNames.map(name => this.emitDef(c, files, name)),
      )

      parts.push(...emitted)

      return parts.filter(p => p.length > 0).join('\n\n')
    })
  }
}

// a scope's content as a stable string (names + kinds + arities), for backdating the name index
function scopeKey(scope: Scope): string {
  return [...scope.entries()]
    .map(
      ([name, binding]) =>
        `${name}:${binding.kind}:${
          'arity' in binding ? binding.arity : ''
        }`,
    )
    .sort()
    .join('|')
}

type FunctionDef = Extract<Statement, { form: 'function' }>

// the function definitions in a program, last-of-name winning (matching the merged-emit dedup)
function functionDefs(program: Program): Map<string, FunctionDef> {
  const map = new Map<string, FunctionDef>()

  for (const statement of program) {
    if (statement.form === 'function') {
      map.set(statement.name, statement)
    }
  }

  return map
}

// span-free structural fingerprint (spans are provenance, never a dependency target)
function structureKey(value: unknown): string {
  return hashText(JSON.stringify(value, withoutSpans))
}

// the function names CALLED in a body (a `call` whose callee is a bare name). Not locals / params / member calls.
function collectCallRefs(statements: Statement[]): Set<string> {
  const refs = new Set<string>()

  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (node.callee.form === 'variable') {
          refs.add(node.callee.name)
        } else {
          expr(node.callee)
        }

        node.args.forEach(expr)
        break
      case 'binary':
        expr(node.left)
        expr(node.right)
        break
      case 'unary':
        expr(node.operand)
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
      case 'member':
        expr(node.target)
        break
      case 'await':
        expr(node.expr)
        break
      case 'closure':
        body(node.body)
        break
      case 'conditional':
        node.branches.forEach(b => {
          expr(b.cond)
          expr(b.value)
        })

        if (node.otherwise) {
          expr(node.otherwise)
        }

        break
      default:
        break
    }
  }

  const body = (list: Statement[]): void => {
    for (const statement of list) {
      switch (statement.form) {
        case 'let':
          expr(statement.init)
          break
        case 'assign':
          expr(statement.target)
          expr(statement.value)
          break
        case 'expression':
          expr(statement.expr)
          break
        case 'return':
          if (statement.value) {
            expr(statement.value)
          }

          break
        case 'throw':
          expr(statement.value)
          break
        case 'hold':
          expr(statement.expr)
          break
        case 'if':
          statement.branches.forEach(br => {
            expr(br.cond)
            body(br.body)
          })

          if (statement.otherwise) {
            body(statement.otherwise)
          }

          break
        case 'while':
          expr(statement.cond)
          body(statement.body)
          break
        case 'match':
          expr(statement.subject)
          statement.cases.forEach(c => body(c.body))

          if (statement.otherwise) {
            body(statement.otherwise)
          }

          break
        case 'for-each':
          expr(statement.iterable)
          body(statement.body)
          break
        case 'function':
          body(statement.body)
          break
        default:
          break
      }
    }
  }

  body(statements)

  return refs
}

// builtins a call may reference that are not user definitions (arithmetic / comparison lowered by the emitter)
const BUILTINS = new Set([
  'add',
  'subtract',
  'multiply',
  'divide',
  'modulo',
  'is-above',
  'is-below',
  'is-equal',
  'is-unequal',
  'is-minimum',
  'is-maximum',
  'increment',
  'decrement',
  'and',
  'or',
  'not',
])
