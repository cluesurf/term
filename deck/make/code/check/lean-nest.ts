// A lean label that names no parameter is a nested call (note/term/lean.md, "position first, then the name").
//
// Under lean a child of a call whose head is a plain name is read by the mill as a LABEL, its children built as an
// array, because the mill cannot know the callee's parameters. The resolver and the checker can. A head that names
// a parameter of the callee is that parameter. A head that names something callable in scope (a task, a method, a
// form, a variant) is a nested call or construction of it, written positionally:
//
//   back join(join(root, <.base>), home)
//
// is `join(join(root, ".base"), home)`, not a call to `join` with a parameter called `join`. Until 2026-10-02 only
// the first half existed, and `pnpm term:lean-equal` found 21 of the CLI's 29 .tree files failing on the second
// (self-hosting-0013). The data DSL lean was built on never nests a call inside a call.
//
// This module is the one rewrite both phases share: `check/resolve.ts` applies it first, where the scope is known,
// so the nested callee resolves (and an imported one counts as used); `check/infer.ts` applies it again for a head
// the resolver cannot see as callable, a form or a variant, which only the checker's tables hold.

import type { Expression } from '@term/make/code/compile/node'
import { binaryBuiltinOp, isBinaryBuiltin } from '@term/make/code/compile/surface'

type Call = Extract<Expression, { form: 'call' }>

// The builtins a bare head folds to an operator, the way the mill folds them (`foldBuiltin` in compile/mint-bridge):
// `subtract a, b` is `a - b`, never a call to a task named `subtract`. A nested one rebuilt here has to fold the
// same way or it reaches the checker as a call to nothing. `not` is the unary one: without it `bits/push(not(x))`, a
// label under a callee with no parameters on record, was refused as a property naming nothing
// (deck/test/code/abstraction-refinement.tree, 2026-10-05, test/check/lean-not-argument.ts)
export function isFoldable(name: string): boolean {
  return isBinaryBuiltin(name) || name === 'increment' || name === 'decrement' || name === 'not'
}

function fold(name: string, args: Expression[], span: Call['span']): Expression | undefined {
  const op = isBinaryBuiltin(name) ? binaryBuiltinOp(name) : undefined

  if (op && args.length === 2) {
    return { form: 'binary', op, left: args[0]!, right: args[1]!, span } as Expression
  }

  if ((name === 'increment' || name === 'decrement') && args.length === 1) {
    return {
      form: 'binary',
      op: name === 'increment' ? '+' : '-',
      left: args[0]!,
      right: { form: 'integer', value: 1, span },
      span,
    } as Expression
  }

  if (name === 'not' && args.length === 1) {
    return { form: 'unary', op: '!', operand: args[0]!, span } as Expression
  }

  return undefined
}

// An argument that was itself written as a property head (`key <x>`), which the mill built as a one-word lean call,
// read back as the label it was. A call that already carries labels of its own is a real nested call and stays.
//
// One ambiguity is accepted and written down: an EXPLICIT `call key` inside a lean call, where `key` is also a
// parameter of the call it sits in, reads as that parameter. `bind key, ...` is the long form that forces it.
// The label is the name the call was WRITTEN with: a callee renamed from an import alias (`rope-text` to `to-string`)
// reads back as its alias, and `imported` carries the imported name, so the nested call keeps its `leanAliases`
// (`trim(rope-text(value))` inside `parse-float(...)` named nothing once a second module defined `to-string`, the
// engine port, 2026-10-04)
function leanLabelOf(item: Expression): { name: string; imported?: string; value: Expression } | undefined {
  if (
    item.form !== 'call' ||
    !item.lean ||
    item.callee.form !== 'variable' ||
    item.callee.name.includes('/') ||
    (item.names ?? []).some(Boolean)
  ) {
    return undefined
  }

  const alias = item.callee.alias

  return {
    name: alias ?? item.callee.name,
    ...(alias !== undefined ? { imported: item.callee.name } : {}),
    value: { form: 'array', items: item.args, span: item.span } as Expression,
  }
}

// Rewrite every lean label of `node` that `isParameter` refuses and `isCallable` accepts into a positional nested
// call. Returns how many it rewrote. The nested call's own property-shaped arguments become labels again, so its own
// arrangement decides them by ITS signature, which is what makes the rule recursive.
export function nestLeanCalls(
  node: Call,
  isParameter: (name: string) => boolean,
  isCallable: (name: string) => boolean,
): number {
  if (!node.lean || !node.leanNames?.some(Boolean)) {
    return 0
  }

  // `''` is no label and no alias (compile/node.ts, `names`)
  const names = node.names ?? node.args.map(() => '')
  const leanNames = node.leanNames
  let rewritten = 0

  node.args = node.args.map((arg, i) => {
    const written = names[i] ?? ''
    // an import alias is a parameter by its written name and a call by the name it imported (compile/node.ts)
    const imported = node.leanAliases?.[i] ?? ''
    const name = imported || written

    if (
      !leanNames[i] ||
      !written ||
      !name ||
      arg.form !== 'array' ||
      isParameter(written) ||
      !isCallable(name)
    ) {
      return arg
    }

    if (node.leanAliases) {
      node.leanAliases[i] = ''
    }

    names[i] = ''
    leanNames[i] = false
    rewritten++

    const folded = fold(name, arg.items, arg.span)

    if (folded) {
      return folded
    }

    const inner = arg.items.map(item => leanLabelOf(item))
    const innerNames = inner.map(one => one?.name ?? '')
    const innerAliases = inner.map(one => one?.imported ?? '')

    return {
      form: 'call',
      callee: { form: 'variable', name, span: arg.span, ...(imported ? { alias: written } : {}) },
      args: arg.items.map((item, at) => inner[at]?.value ?? item),
      span: arg.span,
      lean: true,
      ...(innerNames.some(Boolean)
        ? { names: innerNames, leanNames: innerNames.map(Boolean) }
        : {}),
      ...(innerAliases.some(Boolean) ? { leanAliases: innerAliases } : {}),
    } as Expression
  })

  node.names = names
  node.leanNames = leanNames

  return rewritten
}
