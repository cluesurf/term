// The route-lowering pass: turns `hook` route statements (the routing DSL) into a runnable `route(host, path)`
// dispatcher function. It is the routing counterpart of `zone-lower`. Because the dom layer is env-abstracted (a
// browser Element or an in-memory server node behind the same `view` API), ONE dispatcher works for both client and
// server -- the only difference is the boot (browser mounts on document.body and listens for navigation; a server
// renders per request). So the routing API is identical across environments; this pass is env-agnostic.
//
//   hook </login>            ->   function route(host, path) {
//     zone login                     if (path == "/login") { login(host); return }
//   hook </welcome>                  if (path == "/welcome") { welcome(host); return }
//     zone welcome                 }
//
// A route's optional `seed title <...>` directive becomes a `set-title` call in its branch, so the document title
// tracks the route. Component props (`bind id, read id`) pass through after `host`.

import type {
  Program,
  Statement,
  Expression,
} from '@cluesurf/make/code/compile/node'
import type { Span } from '@cluesurf/make/code/parser/diagnostic'

type RouteStatement = Extract<Statement, { form: 'dock' }>

// a web route is a `dock`/`hook` statement that renders a component (vs a CLI command, which has no component)
function isWebRoute(node: Statement): node is RouteStatement {
  return node.form === 'dock' && !!node.route.component
}

export function lowerRoutes(program: Program, env = 'node'): Program {
  const routes = program.filter(isWebRoute)

  if (!routes.length) {
    return program
  }

  const span: Span = routes[0].span

  const variable = (name: string): Expression => ({
    form: 'variable',
    name,
    span,
  })

  const string = (value: string): Expression => ({
    form: 'string',
    value,
    span,
  })

  const call = (name: string, args: Expression[]): Expression => ({
    form: 'call',
    callee: variable(name),
    args,
    span,
  })

  const exprStatement = (expr: Expression): Statement => ({
    form: 'expression',
    expr,
    span,
  })

  // one `if (path == "<path>") { [set-title;] component(host, ...props); return }` per route
  const branches = routes.map(node => {
    const route = node.route
    const component = route.component!
    const body: Statement[] = []

    const title = route.directives.find(d => d.name === 'title')

    if (title?.value) {
      body.push(exprStatement(call('set-title', [title.value])))
    }

    const args: Expression[] = [variable('host')]

    for (const prop of component.props) {
      if (prop.value) {
        args.push(prop.value)
      }
    }

    body.push(exprStatement(call(component.name, args)))
    body.push({ form: 'return', span })

    return {
      cond: {
        form: 'binary' as const,
        op: '==' as const,
        left: variable('path'),
        right: string(route.path),
        span,
      },
      body,
    }
  })

  const router: Statement = {
    form: 'function',
    name: 'route',
    params: [{ name: 'host' }, { name: 'path' }],
    body: [{ form: 'if', branches, span }],
    generics: [],
    span,
  }

  // the boot: hand the dispatcher + port to the env-abstracted `host`. The browser `host` mounts on the body and
  // listens for navigation; the node `host` starts an HTTP server that SSR-renders each request through the same
  // `route`. One API, two impls -- the native-env mechanism picks which. Signature is `boot(url, port)` so `seed boot`
  // (which calls `app.boot(url, port)`) runs the server entry directly.
  //   function boot(url, port) { host(route, port) }
  const boot: Statement = {
    form: 'function',
    name: 'boot',
    params: [{ name: 'url' }, { name: 'port' }],
    body: [
      exprStatement(call('host', [variable('route'), variable('port')])),
    ],
    generics: [],
    span,
  }

  // drop the route statements; append the dispatcher and the boot
  const out = program.filter(node => !isWebRoute(node))
  out.push(router, boot)

  // the browser build auto-runs the app on load (`boot("", 0)`); the node build leaves `boot` exported for `seed boot`
  // to invoke with the real (url, port).
  if (env === 'browser') {
    out.push(exprStatement(call('boot', [string(''), { form: 'integer', value: 0, span }])))
  }

  return out
}
