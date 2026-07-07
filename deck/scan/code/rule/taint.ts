// Rule scan/taint: an intraprocedural taint check. A function parameter is a taint SOURCE. A call into a host module
// that executes commands or code (child_process.exec/spawn, vm.run*, or a method named exec/eval/query/run on a
// native handle) is a SINK. If tainted data reaches a sink argument without passing through a sanitizer, the rule
// reports it with a source-to-sink trace. This is the classic injection pattern (unsanitized input to a shell / eval
// / query), the same shape CodeQL and Semgrep taint rules catch.
//
// Scope is one function at a time, tracking taint through `save` / `host` bindings (`let`) and reassignment
// (`assign`). It does not follow taint across function boundaries; that needs a call graph, a later addition.

import type {
  Program,
  Statement,
  Expression,
} from '@cluesurf/make/code/compile/node'
import type { CodeFinding } from '../form'
import type { Rule } from '../rule'
import {
  pointOf,
  nativeModules,
  walkExpression,
  walkStatements,
} from '../rule'

// host modules whose methods execute commands or code; any call onto a handle for one is a sink.
const SINK_MODULES = [/(^|[:/])child_process$/, /(^|[:/])vm$/]

// method names that are sinks on any native handle (covers query builders and dynamic evaluation)
const SINK_METHODS = new Set([
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'spawn',
  'spawnSync',
  'eval',
  'run',
  'runInThisContext',
  'runInNewContext',
  'runInContext',
  'query',
])

// a call is a sanitizer when its callee name signals escaping / validation. Anything wrapped in one is treated as
// clean, to avoid false positives on already-sanitized values.
const SANITIZER = /escape|sanitiz|quote|encode|validate|allowlist|whitelist/i

function calleeName(expression: Expression): string | undefined {
  if (expression.form === 'variable') {
    return expression.name
  }

  if (expression.form === 'member') {
    return expression.name
  }

  return undefined
}

// does an expression subtree read any of the given (tainted) names?
function mentionsAny(
  expression: Expression,
  names: Set<string>,
): boolean {
  let found = false

  walkExpression(expression, node => {
    if (node.form === 'variable' && names.has(node.name)) {
      found = true
    }
  })

  return found
}

// is a sanitizer applied anywhere in this expression subtree?
function hasSanitizer(expression: Expression): boolean {
  let found = false

  walkExpression(expression, node => {
    if (node.form === 'call') {
      const name = calleeName(node.callee)

      if (name && SANITIZER.test(name)) {
        found = true
      }
    }
  })

  return found
}

// an expression carries taint when it reads a tainted name and is not sanitized within.
function isTainted(expression: Expression, tainted: Set<string>): boolean {
  return mentionsAny(expression, tainted) && !hasSanitizer(expression)
}

// classify a call as a sink onto a native handle, returning the handle + method when it is one.
function asSink(
  expression: Expression,
  natives: Map<string, string>,
): { handle: string; method: string } | undefined {
  if (expression.form !== 'call') {
    return undefined
  }

  const callee = expression.callee

  if (callee.form !== 'member' || callee.target.form !== 'variable') {
    return undefined
  }

  const handle = callee.target.name
  const method = callee.name
  const moduleName = natives.get(handle)

  if (!moduleName) {
    return undefined
  }

  const moduleIsSink = SINK_MODULES.some(re => re.test(moduleName))

  if (moduleIsSink || SINK_METHODS.has(method)) {
    return { handle, method }
  }

  return undefined
}

// the tainted-variable read inside an argument, for the trace's source point.
function taintSourcePoint(
  expression: Expression,
  tainted: Set<string>,
  file: string,
): { file: string; line: number; column: number } | undefined {
  let point: ReturnType<typeof pointOf> | undefined

  walkExpression(expression, node => {
    if (!point && node.form === 'variable' && tainted.has(node.name)) {
      point = pointOf(file, node.span)
    }
  })

  return point
}

// scan one function body, threading taint through its bindings, reporting each sink reached by tainted data.
function checkFunction(
  fn: Extract<Statement, { form: 'function' }>,
  natives: Map<string, string>,
  file: string,
  findings: CodeFinding[],
): void {
  const tainted = new Set<string>(fn.params.map(p => p.name))

  const visitStatement = (statement: Statement): void => {
    // propagate taint through `save x, <expr>` / `host x, <expr>`
    if (statement.form === 'let') {
      if (isTainted(statement.init, tainted)) {
        tainted.add(statement.name)
      } else {
        tainted.delete(statement.name)
      }
    }

    // and through `save x` reassignment
    if (
      statement.form === 'assign' &&
      statement.target.form === 'variable'
    ) {
      if (isTainted(statement.value, tainted)) {
        tainted.add(statement.target.name)
      } else {
        tainted.delete(statement.target.name)
      }
    }
  }

  const visitExpression = (expression: Expression): void => {
    const sink = asSink(expression, natives)

    if (!sink || expression.form !== 'call') {
      return
    }

    const taintedArg = expression.args.find(arg =>
      isTainted(arg, tainted),
    )

    if (!taintedArg) {
      return
    }

    const sinkPoint = pointOf(file, expression.span)
    const sourcePoint = taintSourcePoint(taintedArg, tainted, file)

    findings.push({
      kind: 'code',
      ruleId: 'scan/taint',
      severity: 'high',
      message: `untrusted input reaches "${sink.handle}/${sink.method}" without sanitizing; a command / code injection risk`,
      at: sinkPoint,
      trace: [
        ...(sourcePoint
          ? [{ ...sourcePoint, label: 'tainted input' }]
          : []),
        { ...sinkPoint, label: `sink: ${sink.handle}/${sink.method}` },
      ],
    })
  }

  // walk in source order so taint propagation sees a `save` binding before the sink that reads it
  walkStatements(fn.body, visitStatement, visitExpression)
}

export const taintRule: Rule = {
  id: 'scan/taint',
  description:
    'Untrusted input (a function parameter) reaches a command / code / query sink without sanitizing.',
  check(program: Program, file: string): CodeFinding[] {
    const natives = nativeModules(program)
    const findings: CodeFinding[] = []

    for (const statement of program) {
      if (statement.form === 'function') {
        checkFunction(statement, natives, file, findings)
      }
    }

    return findings
  },
}
