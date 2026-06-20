// Incremental compiler front-end on the query engine (Tier 2). Source text is an input; parse and mill are memoized
// queries that track their dependencies automatically. Editing one module re-parses and re-mills only that module.
// Crucially, mill backdates (an edit that changes the source but not the milled AST, e.g. a comment, leaves the merged
// program and everything downstream untouched). This is the first phase wired onto the engine; resolve / check / emit
// follow as per-definition queries with the signature firewall. See note/seed/plan/compilation-performance.md (Tier 2).

import { parse } from '@/code/parser/tree'
import { expandTemplates } from '@/code/compile/template'
import type { Template } from '@/code/compile/template'
import { mill } from '@/code/compile/mill'
import { Database, LOW } from '@/code/compile/query'
import type { Durability } from '@/code/compile/query'
import { hashText } from '@/code/compile/cache'
import type { MilledUnit } from '@/code/compile/cache'
import type {
  Program,
  Statement,
  Expression,
} from '@/code/compile/node'
import type { Diagnostic } from '@/code/parser/diagnostic'

export type MergedProgram =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Array<Diagnostic> }

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
  private parsed(file: string): ReturnType<typeof parse> {
    return this.db.query(`parse:${file}`, () =>
      parse({ file, text: this.db.input<string>(`source:${file}`) }),
    )
  }

  // the milled program of a module (a query over its parse). Backdated by structural equality.
  milled(file: string, templates?: Map<string, Template>): MilledUnit {
    return this.db.query(
      `mill:${file}`,
      () => {
        const parsed = this.parsed(file)
        if (!parsed.ok)
          return { ok: false, diagnostics: parsed.diagnostics }
        return mill(expandTemplates(parsed.tree, templates), file)
      },
      milledEquals,
    )
  }

  // the merged program over a set of modules (a query depending on each module's mill). Recomputes only when some
  // module's milled output actually changed, not merely its source text.
  program(files: Array<string>): MergedProgram {
    return this.db.query(`program:${files.join('|')}`, () => {
      const program: Program = []
      for (const file of files) {
        const unit = this.milled(file)
        if (!unit.ok) return { ok: false, diagnostics: unit.diagnostics }
        program.push(...unit.program)
      }
      return { ok: true, program }
    })
  }

  // ---- the per-definition layer (the signature firewall) ----
  // The downstream phases are keyed per definition. The whole-program `program` query recomputes on any real edit, but
  // each per-definition query backdates to its own slice, so a body edit invalidates only that definition's body
  // check, never its callers (which depend on its SIGNATURE, not its body). This is the Salsa firewall on real defs.

  private functions(files: Array<string>): Map<string, FunctionDef> {
    const merged = this.program(files)
    return merged.ok ? functionDefs(merged.program) : new Map()
  }

  // the set of defined function names. Backdates while the set is unchanged (so a body / signature edit, which does
  // not add or remove a name, does not invalidate dependents that only ask "what names exist").
  defNames(files: Array<string>): Array<string> {
    return this.db.query(
      'defNames',
      () => [...this.functions(files).keys()].sort(),
      (a, b) => a.join(',') === b.join(','),
    )
  }

  // a definition's SIGNATURE (params + result, span-free). The firewall boundary: callers depend on this. Backdates
  // when only the body changes, so a body edit never advances it.
  signature(files: Array<string>, name: string): string {
    return this.db.query(`signature:${name}`, () => {
      const fn = this.functions(files).get(name)
      return fn
        ? structureKey({ params: fn.params.map(p => p.type), result: fn.result })
        : ''
    })
  }

  // a definition's body fingerprint + the function names it calls. Backdates when the body is structurally unchanged.
  bodyRefs(
    files: Array<string>,
    name: string,
  ): { bodyKey: string; refs: Array<string> } {
    return this.db.query(
      `bodyRefs:${name}`,
      () => {
        const fn = this.functions(files).get(name)
        if (!fn) return { bodyKey: '', refs: [] }
        return {
          bodyKey: structureKey(fn.body),
          refs: [...collectCallRefs(fn.body)].sort(),
        }
      },
      (a, b) => a.bodyKey === b.bodyKey && a.refs.join(',') === b.refs.join(','),
    )
  }

  // check one definition: every function it calls must be defined or a builtin. Depends on its own body + refs, the
  // name set, and each defined callee's SIGNATURE (never the callee's body). So editing a callee body leaves this
  // green; editing a callee signature re-checks it.
  checkDef(
    files: Array<string>,
    name: string,
  ): { name: string; unresolved: Array<string> } {
    return this.db.query(
      `checkDef:${name}`,
      () => {
        const { refs } = this.bodyRefs(files, name)
        const defined = new Set(this.defNames(files))
        const unresolved: Array<string> = []
        for (const ref of refs) {
          if (defined.has(ref)) {
            void this.signature(files, ref) // the firewall dependency: the callee's signature
          } else if (!BUILTINS.has(ref)) {
            unresolved.push(ref)
          }
        }
        return { name, unresolved }
      },
      (a, b) => a.unresolved.join(',') === b.unresolved.join(','),
    )
  }
}

type FunctionDef = Extract<Statement, { form: 'function' }>

// the function definitions in a program, last-of-name winning (matching the merged-emit dedup)
function functionDefs(program: Program): Map<string, FunctionDef> {
  const map = new Map<string, FunctionDef>()
  for (const statement of program)
    if (statement.form === 'function') map.set(statement.name, statement)
  return map
}

// span-free structural fingerprint (spans are provenance, never a dependency target)
function structureKey(value: unknown): string {
  return hashText(JSON.stringify(value, withoutSpans))
}

// the function names CALLED in a body (a `call` whose callee is a bare name). Not locals / params / member calls.
function collectCallRefs(statements: Array<Statement>): Set<string> {
  const refs = new Set<string>()
  const expr = (node: Expression): void => {
    switch (node.form) {
      case 'call':
        if (node.callee.form === 'variable') refs.add(node.callee.name)
        else expr(node.callee)
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
      default:
        break
    }
  }
  const body = (list: Array<Statement>): void => {
    for (const statement of list)
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
          if (statement.value) expr(statement.value)
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
          if (statement.otherwise) body(statement.otherwise)
          break
        case 'while':
          expr(statement.cond)
          body(statement.body)
          break
        case 'match':
          expr(statement.subject)
          statement.cases.forEach(c => body(c.body))
          if (statement.otherwise) body(statement.otherwise)
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
