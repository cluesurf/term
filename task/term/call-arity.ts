// Every `call` in every .tree file, checked against the callee's declared parameters.
//
// WHY THIS EXISTS. Term's comma returns to the head of the line, so `bind style, call container-style, read vp`
// makes `read vp` a third child of `bind` rather than an argument of `container-style` — the call silently gets
// ZERO arguments. That compiles, and the mistake surfaces far from where it was written. This check found three
// of exactly that in deck/face/code/component/layout.tree, which is why it is here.
//
// It also settles the recurring question about the paren form. `call f(a, b)` and `call f, a, b` build DIFFERENT
// trees — the first gives `call` one child with three of its own, the second gives `call` four children — but
// the mill takes the callee's own children as its arguments, so both resolve to the same call with the same
// argument list. This check compares that resolved list, so it is indifferent to which form was written and
// catches only the cases where the meaning actually changed.
//
// It resolves `find x, name y` aliases and skips names shadowed by a task's own parameters or locals, and it
// collects `bind`-declared native shims as well as `task`s. With those in place it reports ZERO across the tree,
// so any nonzero count is a real finding, not noise.
//
// Run: pnpm term:call-arity

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode, RootNode } from '@term/make/code/parser/narrow'
import { headWord, wordOf } from '@term/make/code/compile/mill-run'

interface Decl {
  name: string
  min: number
  max: number
  file: string
  method: boolean
}

function treeFiles(dir: string, out: string[] = []): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.base' || entry.startsWith('.')) {
      continue
    }

    const path = join(dir, entry)

    // `host` is normally BUILD OUTPUT and must be skipped, but `deck/host` is a real package. A package carries
    // a deck.tree; build output does not. Skipping by name alone silently excluded the whole @term/host package
    // from this walk, which is how ten of its files were missed by the comma migration.
    if (entry === 'host' && !existsSync(join(path, 'deck.tree'))) {
      continue
    }
    const stat = statSync(path)

    if (stat.isDirectory()) {
      treeFiles(path, out)
    } else if (entry.endsWith('.tree')) {
      out.push(path)
    }
  }

  return out
}

// a task's parameters: `take` lines (optional when they carry `fall` or `need false`) and `slot` lines. A task
// declared inside a `form` also takes the receiver, which a method call supplies implicitly.
function declOf(group: GroupNode, file: string, method: boolean): Decl | undefined {
  const name = wordOf(group.nodes[1])

  if (!name) {
    return undefined
  }

  let required = 0
  let total = 0

  for (const child of group.nodes.slice(2)) {
    if (child.kind !== 'group') {
      continue
    }

    const head = headWord(child)

    if (head !== 'take' && head !== 'slot') {
      continue
    }

    total++

    const optional = child.nodes.some(n => n.kind === 'group' && (headWord(n) === 'fall' || headWord(n) === 'need'))

    if (!optional) {
      required++
    }
  }

  return { name, min: required, max: total, file, method }
}

function collect(tree: RootNode, file: string, decls: Map<string, Decl[]>): void {
  const add = (group: GroupNode, method: boolean): void => {
    const decl = declOf(group, file, method)

    if (decl) {
      decls.set(decl.name, [...(decls.get(decl.name) ?? []), decl])
    }
  }

  const walk = (node: Node, inForm: boolean): void => {
    if (node.kind !== 'group') {
      return
    }

    const head = headWord(node)

    if (head === 'task') {
      add(node, inForm)
    }

    for (const child of node.nodes) {
      walk(child, inForm || head === 'form')
    }
  }

  for (const top of tree.nodes) {
    walk(top, false)

    // A native shim is declared with `bind`, not `task`: `bind do-format / take digits / take scale / case node
    // / <...>`. Collecting only `task` resolved `do-format` to an unrelated one-parameter `task do-format` in
    // calendar.tree and reported six perfectly good call sites as mis-nested. Only a TOP-LEVEL `bind` counts —
    // a `bind key, value` inside a call is a named argument, and collecting those would add bogus zero-arity
    // declarations for every field name in the tree.
    if (top.kind === 'group' && headWord(top) === 'bind') {
      add(top, false)
    }
  }
}

// `find <real-name>, name <local-name>` renames an import for one file. A call then uses the LOCAL name, which
// may collide with an unrelated top-level task elsewhere in the tree (`find hash-djb2-xor, name hash` against
// `mask obfuscation`'s own zero-argument `task hash`), so resolving the local name globally compares a call
// against the wrong declaration entirely.
function aliases(tree: RootNode): Map<string, string> {
  const out = new Map<string, string>()

  const walk = (node: Node): void => {
    if (node.kind !== 'group') {
      return
    }

    if (headWord(node) === 'find') {
      const real = wordOf(node.nodes[1])
      const nameGroup = node.nodes.slice(2).find((n): n is GroupNode => n.kind === 'group' && headWord(n) === 'name')
      const local = nameGroup ? wordOf(nameGroup.nodes[1]) : undefined

      if (real && local) {
        out.set(local, real)
      }
    }

    for (const child of node.nodes) {
      walk(child)
    }
  }

  for (const top of tree.nodes) {
    walk(top)
  }

  return out
}

function callArgs(group: GroupNode): { callee: string; count: number } | undefined {
  if (headWord(group) !== 'call' || group.nodes.length < 2) {
    return undefined
  }

  const callee = group.nodes[1]!
  const name = callee.kind === 'group' ? wordOf(callee.nodes[0]) : wordOf(callee)

  if (!name || name.includes('/')) {
    return undefined // a method call on a receiver: arity depends on the receiver's form
  }

  // Not every child of a `call` is an argument. `wait true` is the await marker, `halt kink` propagates the
  // callee's exception, `note`/`show`/`rest` are metadata. Counting those as arguments reports a call as
  // mis-nested when it is written exactly right — which is what the first run of this audit did, flagging 262
  // call sites that were all correct.
  const passenger = new Set(['wait', 'note', 'halt', 'show', 'rest', 'hook', 'like', 'case', 'turn'])
  const isArg = (n: Node): boolean => !(n.kind === 'group' && passenger.has(headWord(n) ?? ''))
  const own = callee.kind === 'group' ? callee.nodes.slice(1).filter(isArg).length : 0

  return { callee: name, count: own + group.nodes.slice(2).filter(isArg).length }
}

const roots = process.argv.slice(2)
const files = roots.flatMap(r => treeFiles(r))
const decls = new Map<string, Decl[]>()
const trees = new Map<string, RootNode>()

for (const file of files) {
  const text = readFileSync(file, 'utf8')

  if (text.includes('note draft') || text.includes('mark draft')) {
    continue
  }

  const parsed = parse({ file, text })

  if (!parsed.ok) {
    continue
  }

  trees.set(file, parsed.tree)
  collect(parsed.tree, file, decls)
}

let checked = 0
let unknown = 0
const bad: string[] = []

// the names bound INSIDE a task: its parameters and its `save` locals. A task-typed one of these (a callback
// passed in, a closure saved locally) is called by name exactly like a top-level task, and shadows any top-level
// task sharing that name — so its arity comes from the value passed at run time, not from the declaration this
// audit can see. Counting those against the top-level declaration reports `call work` / `call hash` / `call
// call` as mis-nested when nothing is wrong.
function localNames(taskGroup: GroupNode, out: Set<string> = new Set()): Set<string> {
  const walk = (n: Node): void => {
    if (n.kind !== 'group') {
      return
    }

    const head = headWord(n)

    if (head === 'take' || head === 'slot' || head === 'save' || head === 'host') {
      const name = wordOf(n.nodes[1])

      if (name) {
        out.add(name)
      }
    }

    for (const child of n.nodes) {
      walk(child)
    }
  }

  walk(taskGroup)

  return out
}

for (const [file, tree] of trees) {
  const alias = aliases(tree)
  const walk = (node: Node, shadowed: Set<string>): void => {
    if (node.kind !== 'group') {
      return
    }

    const scope = headWord(node) === 'task' ? new Set([...shadowed, ...localNames(node)]) : shadowed
    const call = callArgs(node)

    if (call) {
      const resolved = alias.get(call.callee) ?? call.callee
      const options = scope.has(call.callee) ? undefined : decls.get(resolved)

      if (!options) {
        unknown++
      } else {
        checked++

        // a form method call supplies the receiver implicitly, so accept one fewer than declared too
        const fits = options.some(
          d =>
            (call.count >= d.min && call.count <= d.max) ||
            (d.method && call.count >= d.min - 1 && call.count <= d.max - 1),
        )

        if (!fits) {
          const shapes = options.map(d => (d.min === d.max ? `${d.min}` : `${d.min}-${d.max}`)).join(' or ')

          bad.push(`${file}: call ${call.callee} got ${call.count}, declares ${shapes}`)
        }
      }
    }

    for (const child of node.nodes) {
      walk(child, scope)
    }
  }

  for (const top of tree.nodes) {
    walk(top, new Set())
  }
}

console.log(`files ${trees.size}   tasks ${decls.size}   calls checked ${checked}   callee not found ${unknown}`)
console.log(`arity mismatches: ${bad.length}`)

for (const line of bad.slice(0, 60)) {
  console.log(`  ${line}`)
}
