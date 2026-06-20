// Zone component codegen: compile a `zone` to a fine-grained reactive component on the runtime in reactive.ts.
// State becomes signals, hook bodies become handlers that read with `()` and write with the setter. This is the
// Solid-model structure (run-once setup, signals), emitted as clean TypeScript. See
// note/research/vibe/computation/plans/15-components.md. Browser-safe (returns a string).

import type { GroupNode, NameNode, Node } from '@/code/parser/tree'
import { parse } from '@/code/parser/tree'
import type { Diagnostic } from '@/code/parser/diagnostic'

const BINARY: Record<string, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  modulo: '%',
  'is-above': '>',
  'is-below': '<',
  'is-equal': '===',
  'is-unequal': '!==',
}

function nameText(name: NameNode): string {
  return name.parts
    .map(p => (p.kind === 'chunk' ? p.text : ''))
    .join('')
}
function head(group: GroupNode): string | undefined {
  const first = group.nodes[0]
  return first && first.kind === 'name' ? nameText(first) : undefined
}
function rest(group: GroupNode): Array<Node> {
  return group.nodes.slice(1)
}
function toCamel(name: string): string {
  return name.replace(/[-_](.)/g, (_, c: string) => c.toUpperCase())
}
function toPascal(name: string): string {
  const c = toCamel(name)
  return c.charAt(0).toUpperCase() + c.slice(1)
}

export type ZoneResult =
  | { ok: true; typescript: string }
  | { ok: false; diagnostics: Array<Diagnostic> }

export function compileZone(source: {
  file: string
  text: string
}): ZoneResult {
  const parsed = parse(source)
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics }

  const zoneGroup = parsed.tree.nodes.find(g => head(g) === 'zone')
  if (!zoneGroup) return { ok: false, diagnostics: [] }

  const parts = rest(zoneGroup)
  const nameGroup = parts[0]
  const name =
    nameGroup && nameGroup.kind === 'group' ? head(nameGroup) : 'zone'

  // collect state declarations and the set of state names (so reads append `()`)
  const state: Array<{ name: string; init: string }> = []
  const stateNames = new Set<string>()
  for (const node of parts.slice(1)) {
    if (node.kind === 'group' && head(node) === 'state') {
      const inner = rest(node)
      const sName =
        inner[0] && inner[0].kind === 'group'
          ? head(inner[0])
          : undefined
      if (sName) {
        stateNames.add(sName)
        state.push({ name: sName, init: expr(inner[1], stateNames) })
      }
    }
  }

  // collect hook handlers
  const handlers: Array<{ event: string; body: Array<string> }> = []
  for (const node of parts.slice(1)) {
    if (node.kind === 'group' && head(node) === 'hook') {
      const inner = rest(node)
      const event =
        inner[0] && inner[0].kind === 'group'
          ? head(inner[0])
          : undefined
      if (event)
        handlers.push({
          event,
          body: inner.slice(1).map(s => statement(s, stateNames)),
        })
    }
  }

  return { ok: true, typescript: emit(name ?? 'zone', state, handlers) }
}

function expr(node: Node | undefined, stateNames: Set<string>): string {
  if (!node) return 'undefined'
  switch (node.kind) {
    case 'integer':
      return String(node.value)
    case 'decimal':
      return String(node.value)
    case 'text':
      return JSON.stringify(
        node.parts
          .map(p => (p.kind === 'chunk' ? p.text : ''))
          .join(''),
      )
    case 'group': {
      const kw = head(node)
      const args = rest(node)
      if (kw === 'mark') return expr(args[0], stateNames)
      if (kw === 'loan' || kw === 'read' || kw === 'move') {
        const target = args[0]
        const v = target && target.kind === 'group' ? head(target) : ''
        return stateNames.has(v ?? '')
          ? `${toCamel(v ?? '')}()`
          : toCamel(v ?? '')
      }
      if (kw === 'call') {
        const fn =
          args[0] && args[0].kind === 'group'
            ? head(args[0])
            : undefined
        const callArgs = args.slice(1).map(a => expr(a, stateNames))
        if (fn && fn in BINARY && callArgs.length === 2)
          return `${callArgs[0]} ${BINARY[fn]} ${callArgs[1]}`
        if (fn === 'decrement' && callArgs.length === 1)
          return `${callArgs[0]} - 1`
        if (fn === 'increment' && callArgs.length === 1)
          return `${callArgs[0]} + 1`
        return `${toCamel(fn ?? '')}(${callArgs.join(', ')})`
      }
      // a bare name: a variable or state read
      if (kw && args.length === 0)
        return stateNames.has(kw) ? `${toCamel(kw)}()` : toCamel(kw)
      return 'undefined'
    }
    default:
      return 'undefined'
  }
}

function statement(node: Node, stateNames: Set<string>): string {
  if (node.kind !== 'group') return `${expr(node, stateNames)}`
  const kw = head(node)
  if (kw === 'save') {
    const args = rest(node)
    const target =
      args[0] && args[0].kind === 'group' ? head(args[0]) : undefined
    if (target && stateNames.has(target)) {
      return `set${toPascal(target)}(${expr(args[1], stateNames)})`
    }
    return `let ${toCamel(target ?? 'x')} = ${expr(
      args[1],
      stateNames,
    )}`
  }
  return `${expr(node, stateNames)}`
}

function emit(
  name: string,
  state: Array<{ name: string; init: string }>,
  handlers: Array<{ event: string; body: Array<string> }>,
): string {
  const lines: Array<string> = [
    `import { signal } from '@/code/zone/reactive'`,
    '',
  ]
  lines.push(`export function ${toCamel(name)}() {`)
  for (const s of state) {
    lines.push(
      `  const [${toCamel(s.name)}, set${toPascal(s.name)}] = signal(${
        s.init
      })`,
    )
  }
  for (const h of handlers) {
    lines.push(`  function on${toPascal(h.event)}() {`)
    for (const b of h.body) lines.push(`    ${b}`)
    lines.push(`  }`)
  }
  const returned = [
    ...state.map(s => toCamel(s.name)),
    ...handlers.map(h => `on${toPascal(h.event)}`),
  ]
  lines.push(`  return { ${returned.join(', ')} }`)
  lines.push(`}`)
  return lines.join('\n') + '\n'
}
