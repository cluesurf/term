// The route-lowering pass: turns `hook` route statements (the routing DSL) into a runnable `route(host, path)`
// dispatcher function. It is the routing counterpart of `view-lower`. Because the dom layer is env-abstracted (a
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
} from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'
import { NUMBER, STRING } from '@term/make/code/compile/node'

type RouteStatement = Extract<Statement, { form: 'dock' }>

// a web route is a `dock`/`hook` statement that renders a component, OR a resource route that proxies an asset (a
// `proxy` directive, no component -- e.g. `hook </vibe.pdf> / seed proxy, text <url>`). Both dispatch through `route`.
function isWebRoute(node: Statement): node is RouteStatement {
  return (
    node.form === 'dock' &&
    (!!node.route.component ||
      node.route.directives.some(d => d.name === 'proxy' && !!d.value))
  )
}

export function lowerRoutes(program: Program, env = 'node'): Program {
  const routes = program.filter(isWebRoute)

  if (!routes.length) {
    return program
  }

  const span: Span = routes[0]!.span

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

  // a pattern with `:name` segments matches through the navigation contract's `route-matches` (the route runtime,
  // view/route-runtime.tree); a plain path is compared as text. Until 2026-10-03 every path was compared as text, so
  // `hook /users/:id` matched only the literal `/users/:id` and never a user (native-navigation-0002)
  const cond = (path: string): Expression =>
    path.includes('/:')
      ? call('route-matches', [string(path), variable('path')])
      : {
          form: 'binary' as const,
          op: '==' as const,
          left: variable('path'),
          right: string(path),
          span,
        }

  // each `:name` segment of a pattern, a local of that name in its branch, so a prop reads it (`bind id, read id`)
  const parameters = (path: string): Statement[] =>
    path
      .split('/')
      .filter(segment => segment.startsWith(':') && segment.length > 1)
      .map(segment => ({
        form: 'let' as const,
        name: segment.slice(1),
        init: call('route-param', [string(path), variable('path'), string(segment.slice(1))]),
        mutable: false,
        span,
      }))

  // the types the dispatcher and the boot are checked at, so every backend emits them typed rather than inferred. Text
  // and number are the primitive kinds; a `named` text was no type at all, and the checker now refuses it as unknown
  const named = (name: string) => ({ kind: 'named' as const, name })

  // one `if (path == "<path>") { [set-title;] component(host, ...props); return }` per route
  const branches = routes.map(node => {
    const route = node.route

    // a resource route: `seed proxy, text <url>` and no component. Emit `set-proxy(url); return` -- on the server the
    // host fetches the URL and streams the bytes (the page URL stays put); in the browser it does a full navigation.
    const proxy = route.directives.find(
      d => d.name === 'proxy' && d.value,
    )

    if (proxy && !route.component) {
      return {
        cond: cond(route.path),
        body: [
          exprStatement(call('set-proxy', [proxy.value!])),
          { form: 'return' as const, span },
        ],
      }
    }

    const component = route.component!
    // the path's parameters first, so the load and the props can read them
    const body: Statement[] = [...parameters(route.path)]

    // `seed load, read <task>`: the route's data, loaded where the program runs and passed to the props as `data`.
    // Where the data itself lives is the data layer's own env choice (SQLite on a device, the bridge in a cask, the
    // database behind a server), never the router's, so one table and one `load` serve every target
    // (native-navigation-0002, note/term/project/native-navigation.md, "Where a route's load runs")
    const load = route.directives.find(d => d.name === 'load' && d.value)

    if (load) {
      body.push({
        form: 'let',
        name: 'data',
        init: { form: 'call', callee: load.value!, args: [variable('path')], span },
        mutable: false,
        span,
      })
    }

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
      if (!directive.value || directive.name === 'layout' || directive.name === 'load') {
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
          exprStatement(
            call(component.name, [variable('slot'), ...props]),
          ),
        ],
        span,
      }

      body.push(
        exprStatement(call(layoutName, [variable('host'), pageThunk])),
      )
    } else {
      body.push(
        exprStatement(
          call(component.name, [variable('host'), ...props]),
        ),
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
    params: [
      { name: 'host', type: named('view') },
      { name: 'path', type: STRING },
    ],
    // a path no hook matches is a page that is not there: 404, where every unknown path answered 200 with an empty page
    // until 2026-10-04 (guides: applications/web/routes)
    body: [{ form: 'if', branches, otherwise: [exprStatement(call('set-status', [{ form: 'integer', value: 404, span }]))], span }],
    generics: [],
    span,
  }

  // the boot: hand the dispatcher + port to the env-abstracted `host`. The browser `host` mounts on the body and
  // listens for navigation; the node `host` starts an HTTP server that SSR-renders each request through the same
  // `route`. One API, three impls -- the native-env mechanism picks which. Signature is `boot(url, port)` so `seed boot`
  // (which calls `app.boot(url, port)`) runs the server entry directly.
  //   function boot(url, port) { return host(route, port) }
  // `boot` RETURNS whatever `host` returns: node/browser return nothing (harmless), but the Cloudflare host returns a
  // Web fetch handler, which the emitted Worker entry re-exports as `export default`. So one boot serves every target.
  const boot: Statement = {
    form: 'function',
    name: 'boot',
    params: [
      { name: 'url', type: STRING },
      { name: 'port', type: NUMBER },
    ],
    body: [
      {
        form: 'return',
        value: call('host', [variable('route'), variable('port')]),
        span,
      },
    ],
    generics: [],
    span,
  }

  // drop the route statements; append the dispatcher and the boot
  const out: Program = program.filter(node => !isWebRoute(node))
  out.push(router, boot)

  // the browser build auto-runs the app on load (`boot("", 0)`); the node build leaves `boot` exported for `seed boot`
  // to invoke with the real (url, port).
  if (env === 'browser') {
    out.push(
      exprStatement(
        call('boot', [string(''), { form: 'integer', value: 0, span }]),
      ),
    )
  }

  return out
}
