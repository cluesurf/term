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

// a web route is a `dock`/`hook` statement that renders a component, OR a resource route that redirects (a `redirect`
// directive, no component -- e.g. `hook </vibe.pdf> / seed redirect, text <url>`). Both dispatch through `route`.
function isWebRoute(node: Statement): node is RouteStatement {
  return (
    node.form === 'dock' &&
    (!!node.route.component ||
      node.route.directives.some(d => d.name === 'redirect' && !!d.value))
  )
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

  const cond = (path: string) => ({
    form: 'binary' as const,
    op: '==' as const,
    left: variable('path'),
    right: string(path),
    span,
  })

  // one `if (path == "<path>") { [set-title;] component(host, ...props); return }` per route
  const branches = routes.map(node => {
    const route = node.route

    // a resource route: `seed redirect, text <url>` and no component. Emit `set-redirect(url); return` -- on the server
    // the host turns the stashed target into a 302; in the browser `set-redirect` navigates (window.location).
    const redirect = route.directives.find(
      d => d.name === 'redirect' && d.value,
    )

    if (redirect && !route.component) {
      return {
        cond: cond(route.path),
        body: [
          exprStatement(call('set-redirect', [redirect.value!])),
          { form: 'return' as const, span },
        ],
      }
    }

    const component = route.component!
    const body: Statement[] = []

    // a route's `seed` directives become the page's SEO metadata, declared separately from the component (Remix-style):
    // `title` sets the document title; `layout` (handled below) wraps the page; every other directive (`description`,
    // `og:image`, `twitter:card`, ...) becomes a meta tag. On the server these render into the <head>; in the browser
    // they update the live document on navigation.
    const layout = route.directives.find(
      d => d.name === 'layout' && d.value?.form === 'string',
    )
    const layoutName =
      layout?.value?.form === 'string' ? layout.value.value : undefined

    for (const directive of route.directives) {
      if (!directive.value || directive.name === 'layout') {
        continue
      }

      if (directive.name === 'title') {
        body.push(exprStatement(call('set-title', [directive.value])))
      } else {
        body.push(
          exprStatement(
            call('set-meta', [string(directive.name), directive.value]),
          ),
        )
      }
    }

    // the page's props, passed after the host
    const props: Expression[] = []

    for (const prop of component.props) {
      if (prop.value) {
        props.push(prop.value)
      }
    }

    if (layoutName) {
      // wrap the page in its layout (a slotted zone): `layout(host, (slot) => page(slot, ...props))`. The layout renders
      // its chrome with a `slot` outlet; the page builds straight into that outlet. This is the Remix / RR / Next shared
      // layout, declared separately from the page via the route's `layout <name>` directive.
      const pageThunk: Expression = {
        form: 'closure',
        params: [{ name: 'slot' }],
        body: [
          exprStatement(call(component.name, [variable('slot'), ...props])),
        ],
        span,
      }

      body.push(
        exprStatement(call(layoutName, [variable('host'), pageThunk])),
      )
    } else {
      body.push(
        exprStatement(call(component.name, [variable('host'), ...props])),
      )
    }

    body.push({ form: 'return', span })

    return {
      cond: cond(route.path),
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
