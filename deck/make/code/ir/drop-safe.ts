// Find the heap-owned local bindings of a function that are SINGLE-OWNER and therefore safe to drop exactly once at
// function exit, with no dup and no double-free risk. This is a sound, conservative subset of Perceus: a binding
// qualifies only when every use of it is *borrowing* (it never transfers ownership), so the binding holds the only
// reference and a single drop at scope exit frees it.
//
// Borrowing uses (do not consume): a collection/string method receiver (`x/length`, `x/push` -- the handle stays
// live), a binary operand (string concat / comparison read but do not free), a field read (`x/field`). Consuming
// uses (transfer ownership, so the binding is NOT single-owner): being stored into a structure (a list/array element,
// a map value, a record field), being passed as a Seed-function argument or a method's non-receiver argument, being
// returned, or being aliased into another binding (`save y, read x`). A binding with any consuming use is left alone
// (it stays leaked, exactly as today -- no regression), so this never frees something that is still reachable.

import type {
  Statement,
  Expression,
} from '@cluesurf/make/code/compile/node'

function isHeapType(type?: { kind: string }): boolean {
  if (!type) {return false}

  return (
    type.kind === 'string' ||
    type.kind === 'array' ||
    type.kind === 'map' ||
    type.kind === 'named' ||
    type.kind === 'bytes'
  )
}

// collect the names of variables read in a CONSUMING position anywhere in the body
function collectConsuming(body: Statement[], consumed: Set<string>): void {
  const named = (node: Expression): string | undefined =>
    node.form === 'variable' ? node.name : undefined

  // an expression in a consuming position: if it is a bare variable, that variable is consumed
  const consume = (node: Expression): void => {
    const name = named(node)
    if (name) {consumed.add(name)}
  }

  const walkExpr = (node: Expression): void => {
    switch (node.form) {
      case 'call': {
        if (node.callee.form === 'member') {
          // a method call: the receiver (member target) is borrowed; the other args are consuming
          walkExpr(node.callee.target)
          for (const arg of node.args) {
            consume(arg)
            walkExpr(arg)
          }
        } else {
          // a Seed-function call: every argument is consumed
          walkExpr(node.callee)
          for (const arg of node.args) {
            consume(arg)
            walkExpr(arg)
          }
        }
        break
      }
      case 'array':
        for (const item of node.items) {
          consume(item)
          walkExpr(item)
        }
        break
      case 'record':
        for (const field of node.fields) {
          consume(field.value)
          walkExpr(field.value)
        }
        break
      case 'map':
        for (const entry of node.entries) {
          consume(entry.key)
          consume(entry.value)
          walkExpr(entry.key)
          walkExpr(entry.value)
        }
        break
      case 'binary':
        // operands are borrowed (concat / comparison read but do not free)
        walkExpr(node.left)
        walkExpr(node.right)
        break
      case 'unary':
        walkExpr(node.operand)
        break
      case 'member':
        // a field read borrows the target
        walkExpr(node.target)
        break
      case 'await':
        walkExpr(node.expr)
        break
      case 'conditional':
        for (const branch of node.branches) {
          walkExpr(branch.cond)
          walkExpr(branch.value)
        }
        if (node.otherwise) {walkExpr(node.otherwise)}
        break
      default:
        break
    }
  }

  const walkStmt = (s: Statement): void => {
    switch (s.form) {
      case 'let':
        // a `save y, read x` aliases x (a second owner) -> x is consumed
        consume(s.init)
        walkExpr(s.init)
        break
      case 'assign':
        consume(s.value)
        walkExpr(s.value)
        walkExpr(s.target)
        break
      case 'expression':
        walkExpr(s.expr)
        break
      case 'return':
        if (s.value) {
          consume(s.value) // a returned binding is moved out
          walkExpr(s.value)
        }
        break
      case 'throw':
        consume(s.value)
        walkExpr(s.value)
        break
      case 'if':
        for (const branch of s.branches) {
          walkExpr(branch.cond)
          collectConsuming(branch.body, consumed)
        }
        if (s.otherwise) {collectConsuming(s.otherwise, consumed)}
        break
      case 'while':
        walkExpr(s.cond)
        collectConsuming(s.body, consumed)
        break
      case 'for-each':
        consume(s.iterable)
        walkExpr(s.iterable)
        collectConsuming(s.body, consumed)
        break
      case 'match':
        walkExpr(s.subject)
        for (const c of s.cases) {collectConsuming(c.body, consumed)}
        if (s.otherwise) {collectConsuming(s.otherwise, consumed)}
        break
      default:
        break
    }
  }

  for (const s of body) {walkStmt(s)}
}

// the heap-owned local bindings (`save`) that no use consumes -- safe to drop once at function exit.
export function dropSafeHeapLocals(
  fn: Extract<Statement, { form: 'function' }>,
): Set<string> {
  const consumed = new Set<string>()
  collectConsuming(fn.body, consumed)

  const safe = new Set<string>()

  const scan = (body: Statement[]): void => {
    for (const s of body) {
      if (
        s.form === 'let' &&
        isHeapType(s.init.type ?? s.type) &&
        !consumed.has(s.name)
      ) {
        safe.add(s.name)
      }

      // descend into nested blocks so a binding declared inside a branch is found too
      if (s.form === 'if') {
        for (const b of s.branches) {scan(b.body)}
        if (s.otherwise) {scan(s.otherwise)}
      } else if (s.form === 'while' || s.form === 'for-each') {
        scan(s.body)
      } else if (s.form === 'match') {
        for (const c of s.cases) {scan(c.body)}
        if (s.otherwise) {scan(s.otherwise)}
      }
    }
  }

  scan(fn.body)

  return safe
}
