// A page route declares only what the build turns into code.
//
// `hook /data` / `task get` compiled clean, was counted in host/roll.json as `get /data`, and emitted nothing: the
// route lowering (compile/route-lower.ts) builds a branch per route that renders a component or proxies an asset, and
// reads no method (guides: applications/web/routes, 2026-10-03). A method handler under a page route is refused,
// naming the spelling that does serve one, a `route` record handed to `route-server`.
//
// A command (`hook make` / `task make-deck`) is not a route: its `task <impl>` is its handler, collected as a call, so
// only a dock built as a route (it carries the `component` key, see mint-bridge.ts) is read here.

import type { Program, Statement } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'

type Dock = Extract<Statement, { form: 'dock' }>

export function checkRouteMethods(program: Program, file: string): Diagnostic[] {
  const out: Diagnostic[] = []

  const walk = (route: Dock['route']): void => {
    if (route.page) {
      for (const method of route.methods) {
        out.push(
          diagnose('not-implemented', {
            file,
            span: method.span,
            message: `\`task ${method.name}\` under the page route \`${route.path}\` builds no code: a page route renders a \`view\` or proxies an asset`,
            hint: 'serve an HTTP method with a `route` record (method, path, handle) passed to `route-server`, from @term/site/http/http',
          }),
        )
      }
    }

    route.children.forEach(walk)
  }

  for (const s of program) {
    if (s.form === 'dock' && s.span.file === file) {
      walk(s.route)
    }
  }

  return out
}
