// The lockfile: the deterministic, resolved dependency graph. It is written in tree syntax, so we parse it with
// our own parser and serialize it back deterministically (stable ordering), guaranteeing reproducible installs.
// See note/research/vibe/computation/plans/16-package-manager.md. Browser-safe.

import type {
  GroupNode,
  NameNode,
  Node,
  RootNode,
} from '@cluesurf/make/code/parser/tree'
import { parse } from '@cluesurf/make/code/parser/tree'

export type LockRequest = {
  name: string
  range: string
  locked: string
}
export type LockDependency = { name: string; version: string }
export type LockLink = {
  ref: string
  hash: string
  deps: Array<LockDependency>
}
export type Lockfile = {
  base: string
  requests: Array<LockRequest>
  links: Array<LockLink>
}

function nameText(name: NameNode): string {
  return name.parts
    .map(p => (p.kind === 'chunk' ? p.text : ''))
    .join('')
}
function headName(group: GroupNode): string | undefined {
  const first = group.nodes[0]
  return first && first.kind === 'name' ? nameText(first) : undefined
}
function rest(group: GroupNode): Array<Node> {
  return group.nodes.slice(1)
}
// read the first argument of a group as a plain value (text chunk or name)
function value(group: GroupNode): string {
  const arg = rest(group)[0]
  if (!arg) return ''
  if (arg.kind === 'text')
    return arg.parts
      .map(p => (p.kind === 'chunk' ? p.text : ''))
      .join('')
  if (arg.kind === 'name') return nameText(arg)
  if (arg.kind === 'group') return headName(arg) ?? ''
  return ''
}
// find a child group by head keyword
function child(
  group: GroupNode,
  keyword: string,
): GroupNode | undefined {
  for (const node of rest(group))
    if (node.kind === 'group' && headName(node) === keyword) return node
  return undefined
}

export function parseLockfile(text: string): Lockfile {
  const lock: Lockfile = { base: '', requests: [], links: [] }
  const result = parse({ file: 'deck.lock.tree', text })
  if (!result.ok) return lock
  const tree: RootNode = result.tree

  for (const group of tree.nodes) {
    const keyword = headName(group)
    if (keyword === 'base') {
      lock.base = value(group)
    } else if (keyword === 'load') {
      const markGroup = child(group, 'mark')
      const lockGroup = child(group, 'lock')
      lock.requests.push({
        name: value(group),
        range: markGroup ? value(markGroup) : '*',
        locked: lockGroup ? value(lockGroup) : '',
      })
    } else if (keyword === 'link') {
      const hashGroup = child(group, 'hash')
      const deps: Array<LockDependency> = []
      for (const node of rest(group)) {
        if (node.kind === 'group' && headName(node) === 'load') {
          const markGroup = child(node, 'mark')
          deps.push({
            name: value(node),
            version: markGroup ? value(markGroup) : '',
          })
        }
      }
      lock.links.push({
        ref: value(group),
        hash: hashGroup ? value(hashGroup) : '',
        deps,
      })
    }
  }
  return lock
}

export function serializeLockfile(lock: Lockfile): string {
  const lines: Array<string> = [`base <${lock.base}>`, '']

  // deterministic ordering: requests by name, links by ref, deps by name
  const requests = [...lock.requests].sort((a, b) =>
    a.name.localeCompare(b.name),
  )
  for (const request of requests) {
    lines.push(`load ${request.name}`)
    lines.push(`  mark <${request.range}>`)
    lines.push(`  lock <${request.locked}>`)
    lines.push('')
  }

  const links = [...lock.links].sort((a, b) =>
    a.ref.localeCompare(b.ref),
  )
  for (const link of links) {
    lines.push(`link <${link.ref}>`)
    lines.push(`  hash <${link.hash}>`)
    const deps = [...link.deps].sort((a, b) =>
      a.name.localeCompare(b.name),
    )
    for (const dep of deps) {
      lines.push(`  load ${dep.name}`)
      lines.push(`    mark <${dep.version}>`)
    }
    lines.push('')
  }

  return lines.join('\n').replace(/\n+$/, '\n')
}
