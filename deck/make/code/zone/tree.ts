// Zone / dock emit to Seed (.tree). Takes the compile AST the mill produced for a `zone` or `dock` and emits the
// `.tree` source that calls the render runtime in site.tree (zone/render, zone/reactive, dom/dom). A `zone` becomes a
// `task` that builds its view; a `dock` becomes a route descriptor. This is the canonical, backend-agnostic lowering:
// the emitted `.tree` itself compiles to every target (the DOM work is delegated to native per env). Pure / browser-safe.

import type {
  DockRoute,
  Expression,
  Statement,
  Type,
  ZoneNode,
} from '@cluesurf/make/code/compile/node'

const OP_NAME: Record<string, string> = {
  '+': 'add',
  '-': 'subtract',
  '*': 'multiply',
  '/': 'divide',
  '%': 'modulo',
  '>': 'is-above',
  '<': 'is-below',
  '==': 'is-equal',
  '!=': 'is-unequal',
  '>=': 'is-minimum',
  '<=': 'is-maximum',
  '&&': 'and',
  '||': 'or',
}

const pad = (depth: number): string => '  '.repeat(depth)

function typeName(type: Type | undefined): string {
  switch (type?.kind) {
    case 'string':
      return 'text'
    case 'boolean':
      return 'boolean'
    case 'number':
      return 'number'
    case 'named':
      return type.name
    default:
      return 'text'
  }
}

// a member chain back to a slash path: member(member(var a, b), c) -> a/b/c
function memberPath(expr: Expression): string {
  if (expr.form === 'variable') {
    return expr.name
  }

  if (expr.form === 'member') {
    return `${memberPath(expr.target)}/${expr.name}`
  }

  return 'self'
}

// an expression to `.tree` value lines at the given depth
function expr(node: Expression, depth: number): string[] {
  switch (node.form) {
    case 'integer':
    case 'float':
      return [`${pad(depth)}mark ${node.value}`]
    case 'boolean':
      return [`${pad(depth)}wave ${node.value}`]
    case 'string':
      return [`${pad(depth)}text <${node.value}>`]
    case 'unit':
      return [`${pad(depth)}mark 0`]
    case 'variable':
      return [`${pad(depth)}read ${node.name}`]
    case 'member':
      return [`${pad(depth)}read ${memberPath(node)}`]
    case 'binary':
      return [
        `${pad(depth)}call ${OP_NAME[node.op]}`,
        ...expr(node.left, depth + 1),
        ...expr(node.right, depth + 1),
      ]

    case 'call': {
      const callee =
        node.callee.form === 'variable'
          ? node.callee.name
          : node.callee.form === 'member'
            ? memberPath(node.callee)
            : 'call'

      return [
        `${pad(depth)}call ${callee}`,
        ...node.args.flatMap(a => expr(a, depth + 1)),
      ]
    }

    case 'await':
      return expr(node.expr, depth)
    default:
      return [`${pad(depth)}mark 0`]
  }
}

type Context = { count: number }
const fresh = (ctx: Context, base: string): string =>
  `${base}-${(ctx.count += 1)}`

// emit the `.tree` that builds one zone node and appends it under `host`
function zoneNode(
  node: ZoneNode,
  host: string,
  depth: number,
  ctx: Context,
): string[] {
  const out: string[] = []
  const p = pad(depth)

  switch (node.form) {
    case 'element': {
      const self = fresh(ctx, node.name)
      out.push(
        `${p}save ${self}`,
        `${pad(depth + 1)}call element`,
        `${pad(depth + 2)}bind tag, text <${node.name}>`,
      )

      for (const attribute of node.attributes) {
        if (attribute.event) {
          const handler = fresh(ctx, 'on')
          out.push(
            `${p}call event`,
            `${pad(depth + 1)}bind node, read ${self}`,
            `${pad(depth + 1)}bind name, text <${attribute.name}>`,
            `${pad(depth + 1)}bind handler`,
            `${pad(depth + 2)}task ${handler}`,
            ...expr(attribute.value, depth + 3),
          )
        } else {
          out.push(
            `${p}call attribute`,
            `${pad(depth + 1)}bind node, read ${self}`,
            `${pad(depth + 1)}bind name, text <${attribute.name}>`,
            `${pad(depth + 1)}bind value`,
            ...expr(attribute.value, depth + 2),
          )
        }
      }

      for (const child of node.children) {
        out.push(...zoneNode(child, self, depth, ctx))
      }

      out.push(
        `${p}call append`,
        `${pad(depth + 1)}bind parent, read ${host}`,
        `${pad(depth + 1)}bind child, read ${self}`,
      )

      return out
    }

    case 'text':
      out.push(
        `${p}call append`,
        `${pad(depth + 1)}bind parent, read ${host}`,
        `${pad(depth + 1)}bind child`,
        `${pad(depth + 2)}call text`,
        `${pad(depth + 3)}bind value, text <${node.value}>`,
      )

      return out

    case 'read': {
      const getter = fresh(ctx, 'get')
      out.push(
        `${p}call append`,
        `${pad(depth + 1)}bind parent, read ${host}`,
        `${pad(depth + 1)}bind child`,
        `${pad(depth + 2)}call dynamic`,
        `${pad(depth + 3)}bind get`,
        `${pad(depth + 4)}task ${getter}`,
        `${pad(depth + 5)}send back`,
        ...expr(node.value, depth + 6),
      )

      return out
    }

    case 'save':
      out.push(`${p}save ${node.name}`, ...expr(node.value, depth + 1))

      return out
    case 'slot':
      // the children outlet: append the passed-in children node
      out.push(
        `${p}call append`,
        `${pad(depth + 1)}bind parent, read ${host}`,
        `${pad(depth + 1)}bind child, read children`,
      )

      return out

    case 'fork': {
      const when = fresh(ctx, 'when')
      const then = fresh(ctx, 'then')
      const other = fresh(ctx, 'else')
      out.push(
        `${p}call show`,
        `${pad(depth + 1)}bind host, read ${host}`,
      )
      out.push(
        `${pad(depth + 1)}bind when`,
        `${pad(depth + 2)}task ${when}`,
        `${pad(depth + 3)}send back`,
        ...expr(
          node.branches[0]?.cond ?? {
            form: 'boolean',
            value: false,
            span: node.span,
          },
          depth + 4,
        ),
      )
      out.push(
        `${pad(depth + 1)}bind then`,
        `${pad(depth + 2)}task ${then}`,
        ...fragment(node.branches[0]?.body ?? [], depth + 3, ctx),
      )
      out.push(
        `${pad(depth + 1)}bind other`,
        `${pad(depth + 2)}task ${other}`,
        ...fragment(node.otherwise ?? [], depth + 3, ctx),
      )

      return out
    }

    case 'walk': {
      const build = fresh(ctx, 'build')
      out.push(
        `${p}call each`,
        `${pad(depth + 1)}bind host, read ${host}`,
        `${pad(depth + 1)}bind items`,
        ...expr(node.iterable, depth + 2),
        `${pad(depth + 1)}bind build`,
        `${pad(depth + 2)}task ${build}`,
        `${pad(depth + 3)}take ${node.item}, like node`,
        ...fragment(node.body, depth + 3, ctx),
      )

      return out
    }

    default:
      return out
  }
}

// build a list of nodes into a fresh container and return it (used where a single node must be returned)
function fragment(
  nodes: ZoneNode[],
  depth: number,
  ctx: Context,
): string[] {
  const box = fresh(ctx, 'box')
  const out: string[] = [
    `${pad(depth)}save ${box}`,
    `${pad(depth + 1)}call element`,
    `${pad(depth + 2)}bind tag, text <span>`,
  ]

  for (const node of nodes) {
    out.push(...zoneNode(node, box, depth, ctx))
  }

  out.push(`${pad(depth)}send back, read ${box}`)

  return out
}

// emit a `zone` definition as a `task` that builds its view through the render runtime
export function emitZoneTree(
  zone: Extract<Statement, { form: 'zone' }>,
): string {
  const ctx: Context = { count: 0 }
  const out: string[] = [`task ${zone.name}`, `  take host, like node`]

  for (const param of zone.params) {
    out.push(`  take ${param.name}, like ${typeName(param.type)}`)
  }

  for (const node of zone.body) {
    out.push(...zoneNode(node, 'host', 1, ctx))
  }

  return out.join('\n') + '\n'
}

// emit a `dock` route as a descriptor record (path, methods/component/handlers) the router consumes
export function emitDockTree(
  dock: Extract<Statement, { form: 'dock' }>,
): string {
  return route(dock.route, 0).join('\n') + '\n'
}

function route(node: DockRoute, depth: number): string[] {
  const p = pad(depth)
  const out: string[] = [
    `${p}make route`,
    `${pad(depth + 1)}bind path, text <${node.path}>`,
  ]

  for (const method of node.methods) {
    out.push(
      `${pad(depth + 1)}bind method`,
      `${pad(depth + 2)}make handler`,
      `${pad(depth + 3)}bind verb, text <${method.name}>`,
    )

    for (const call of method.calls) {
      out.push(`${pad(depth + 3)}bind call, text <${call.name}>`)
    }
  }

  for (const call of node.calls) {
    out.push(`${pad(depth + 1)}bind call, text <${call.name}>`)
  }

  if (node.component) {
    out.push(
      `${pad(depth + 1)}bind zone, text <${node.component.name}>`,
    )
  }

  for (const child of node.children) {
    out.push(`${pad(depth + 1)}bind child`)
    out.push(...route(child, depth + 2))
  }

  return out
}
