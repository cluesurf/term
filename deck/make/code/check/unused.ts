// Unused-binding warnings: a `let`/`save` binding that is never read is reported as a warning (not an error, so
// it does not fail compilation). A usability nicety. See note/research/vibe/computation/plans/04-typecheck.md.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'

function collectReads(expr: Expression, read: Set<string>): void {
  switch (expr.form) {
    case 'variable':
      read.add(expr.name)
      break
    case 'binary':
      collectReads(expr.left, read)
      collectReads(expr.right, read)
      break
    case 'unary':
      collectReads(expr.operand, read)
      break
    case 'await':
      collectReads(expr.expr, read)
      break
    case 'template':
      for (const part of expr.parts) {
        if (part.form === 'value') {
          collectReads(part.value, read)
        }
      }

      break
    case 'member':
      collectReads(expr.target, read)

      // `xs/{at}` reads `at` too: the index was skipped, and a binding used only there was warned as never used
      // (guides: proofs, 2026-10-05)
      if (expr.index) {
        collectReads(expr.index, read)
      }

      break
    case 'call':
      collectReads(expr.callee, read)

      for (const arg of expr.args) {
        collectReads(arg, read)
      }

      break
    case 'array':
      for (const item of expr.items) {
        collectReads(item, read)
      }

      break
    case 'map':
      for (const entry of expr.entries) {
        collectReads(entry.key, read)
        collectReads(entry.value, read)
      }

      break
    case 'record':
      for (const field of expr.fields) {
        collectReads(field.value, read)
      }

      break
    case 'conditional':
      for (const branch of expr.branches) {
        collectReads(branch.cond, read)
        collectReads(branch.value, read)
      }

      if (expr.otherwise) {
        collectReads(expr.otherwise, read)
      }

      break
    default:
      break
  }
}

function walk(
  body: Statement[],
  declared: Map<string, Statement>,
  read: Set<string>,
): void {
  for (const statement of body) {
    switch (statement.form) {
      case 'let':
        collectReads(statement.init, read)

        // a re-`save` to an existing name counts as a use of the binding's slot; only record first declaration
        if (!declared.has(statement.name)) {
          declared.set(statement.name, statement)
        }

        break
      case 'assign':
        collectReads(statement.target, read)
        collectReads(statement.value, read)
        break
      case 'expression':
        collectReads(statement.expr, read)
        break
      case 'return':
        if (statement.value) {
          collectReads(statement.value, read)
        }

        break
      case 'throw':
        collectReads(statement.value, read)
        break
      case 'hold':
        collectReads(statement.expr, read)
        break
      case 'while':
        collectReads(statement.cond, read)
        walk(statement.body, declared, read)
        break
      case 'guard':
        walk(statement.body, declared, read)

        if (statement.catch) {
          walk(statement.catch.body, declared, read)
        }

        break
      case 'for-each':
        collectReads(statement.iterable, read)
        walk(statement.body, declared, read)
        break
      case 'match':
        collectReads(statement.subject, read)

        for (const branch of statement.cases) {
          walk(branch.body, declared, read)
        }

        if (statement.otherwise) {
          walk(statement.otherwise, declared, read)
        }

        break
      case 'if':
        for (const branch of statement.branches) {
          collectReads(branch.cond, read)
          walk(branch.body, declared, read)
        }

        if (statement.otherwise) {
          walk(statement.otherwise, declared, read)
        }

        break
      default:
        break
    }
  }
}

// the marks of every rule a rule's goal cites, which its own names of the same spelling instance
function citedMarks(body: Statement[], program: Program): Set<string> {
  const marks = new Set<string>()
  const rules = new Map(program.flatMap(s => (s.form === 'function' && s.theorem ? [[s.name, s] as const] : [])))

  const steps = (proof: { head: string; arg?: string; children?: { head: string; arg?: string }[] }[]): void => {
    for (const step of proof) {
      if (step.head === 'cite' && step.arg) {
        rules.get(step.arg)?.params.forEach(p => marks.add(p.name))
      }

      steps(step.children ?? [])
    }
  }

  const visit = (statements: Statement[]): void => {
    for (const s of statements) {
      if (s.form === 'hold') {
        steps(s.proof ?? [])
      } else if (s.form === 'if') {
        s.branches.forEach(b => visit(b.body))
      }
    }
  }

  visit(body)

  return marks
}

export function findUnused(
  program: Program,
  file: string,
): Diagnostic[] {
  const warnings: Diagnostic[] = []

  // program-wide references: every name read in any function body (call targets included, since a `call helper`
  // reads the `helper` variable). Used to spot a private function that nothing in the program calls.
  const referenced = new Set<string>()

  for (const statement of program) {
    if (statement.form === 'function') {
      walk(statement.body, new Map(), referenced)
    }
  }

  for (const statement of program) {
    // each module reports its own, as check/type-names.ts does. A task merged in from another file carries that
    // file's span, and stamping it with this one printed `"next" is never used` at clean.tree:147 over a line of
    // paint.tree, once for every file of the package that loaded it (2026-10-04)
    if (statement.form !== 'function' || (statement.span.file !== undefined && statement.span.file !== file)) {
      continue
    }

    const declared = new Map<string, Statement>()
    const read = new Set<string>()
    walk(statement.body, declared, read)

    // a RULE'S `find` named for a cited rule's mark is read by the citation, which instances that rule by name
    // (`find n, b` beside `cite count-is-not-negative`): check/holds.ts `citedFacts`
    if (statement.theorem) {
      citedMarks(statement.body, program).forEach(name => read.add(name))
    }

    for (const [name, decl] of declared) {
      if (!read.has(name)) {
        warnings.push(
          diagnose('unused-binding', {
            file,
            span: decl.span,
            message: `"${name}" is never used`,
          }),
        )
      }
    }

    // a private function nothing references is dead code. Only `private`: a public definition may be called from
    // outside this compilation (the package's surface), so its absence of internal callers is not a defect.
    if (statement.private && !referenced.has(statement.name)) {
      warnings.push(
        diagnose('unused-binding', {
          file,
          span: statement.span,
          message: `private "${statement.name}" is never used`,
        }),
      )
    }
  }

  return warnings
}
