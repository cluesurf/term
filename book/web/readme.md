# The app framework

Build a full application in one language. Server, client, routing, UI, and data are all `.tree`, compiled per target. There is no client/server split to maintain and no virtual DOM. You write `view` components, `hook /path` page routes, and `route` records for the server. The framework, `@term/site`, supplies render, server-side rendering, navigation, and serving. The environment is swapped underneath, never the app code.

A component was spelled `zone` and a route `dock /path` until the end of August 2026. Both are gone: `zone` is the secret system now, `dock` is the native binding, and `@cluesurf/site/code/zone/...` does not exist.

Maps to: Next.js or Remix or SolidStart, but one route table drives both sides and the compiler owns the lowering.

## The pieces

| Piece | Head | What it is | Page |
| --- | --- | --- | --- |
| Component | `view` | A reactive UI component (signals, real DOM nodes) | [views](components.md) |
| Reactive state | `make-signal` | A signal: a value plus its observers | [state](state.md) |
| Page route | `hook /path` | Maps a URL path to a component | [routes](routes.md), [navigation](navigation.md) |
| Server route | `make route` | A method, a path, and a handler task, for the trie router | [routes](routes.md) |
| Request / response | `request` / `response` | The forms an HTTP handler reads and returns | [routes](routes.md) |
| Data fetching | `call get` with `wait true` | Loading remote data into a signal | [fetch](fetch.md) |
| Forms | inputs with `name`, read by `get-value` | Field refs, validation tasks, an error signal | [forms](forms.md) |
| Auth | route handlers you write | Login, tokens, sessions, guards | [auth](auth.md) |
| Realtime | `connect` from `network/websocket` | A WebSocket client. No server half yet | [channels](channels.md) |

## How an app is laid out

A Term app is an ordinary package whose `deck.tree` links `@term/site`. Its UI lives in `view` modules, its page routes in a `hook` table, and its server-side logic in handler tasks. The build compiles the whole tree to `host/`. The same route table is used to render on the server and to navigate on the client.

```
my-app/
  deck.tree          # package manifest, links @term/base and @term/site
  base/
    role.tree        # marks code/route.tree as the page route table
  code/
    route.tree       # the page routes (hook /path)
    boot.tree        # the views, and the boot task
    hook/            # server route handlers
```

The blog in `deck/site/test/site/` is the one application laid out this way end to end: `back/` the data model and queries, `hook/` the HTTP API, `face/` the components, and `cask.tree` a native window.

## The two boots

The framework's `host` is env-abstracted: one API, one implementation per platform, chosen at build time. The app author never writes the split. A `route(host, path)` task picks the page for a path, and a `boot(url, port)` task hands `route` to `host`.

- **Browser boot.** Clear the page body, render the route's component into it, then listen for navigation. Client navigation re-runs the same dispatcher (single-page app), no full reload.
- **Server boot.** Start an HTTP server. For every request, build a fresh in-memory root, run the same `route(host, path)` into it, serialize the tree to HTML, wrap it in the document shell, and respond.

Because both sides call one dispatcher over one component model, there is no `getServerSideProps` versus client-component divide. Write once, the env is swapped under you.

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/native/{platform}/host
  find host

view home
  take host, like view
  view h1
    text <Home>

view about
  take host, like view
  take who, like text
  view p
    read who

# pick the page for a path
task route
  take host, like view
  take path, like text
  fork test
    hook test
      call is-equal
        read path
        text </>
    hook hold
      call home
        read host
    hook test
      call is-equal
        read path
        text </about>
    hook hold
      call about
        read host
        text <Ada>

# `term boot` calls this with the port
task boot
  take url, like text
  take port, like u16
  call host
    read route
    read port
```

## The request lifecycle (server)

```tree
load @term/site/code/http/http
  find request

task sample-request
  like request
  send back
    make request
      bind method, text <GET>
      bind path, text </users/42>
      bind body, text <>
```

1. A request arrives with a `method`, `path`, and `body`.
2. The router (a segment trie) matches the path to a handler and binds path params into a `hash`.
3. For a page, the server renders the matched `view` into an in-memory root, serializes it to HTML, and wraps it in the document shell.
4. For a server route, the handler task runs and returns a `response`.
5. A `response` carries a `status` and a `body`.

```tree
load @term/site/code/http/http
  find response

task ok
  like response
  send back
    make response
      bind status, code 200
      bind body, text <ok>
```

When no server route matches, the router returns a `404` automatically. An unknown page path renders an empty body with status 200.

## Wiring it together with `term boot`

`term boot` builds the server and the client bundle, finds the `boot` task, and runs it.

```bash
term make            # compile .tree to host/ (pages, the router, the stylesheet)
term boot            # run the server boot: SSR over the same routes, per request
term boot --port 3000
term halt            # stop running servers
```

The browser build runs its boot when the page loads. It clears the server's markup and renders the page again, since there is no hydration yet. See [routes](routes.md) for the route table, [views](components.md) for components, and [the CLI](../toolchain/readme.md) for `boot`, `make`, and friends.

## Pages in this section

- [routes](routes.md) -- page routes with `hook /path`, server routes with `route` records
- [views](components.md) -- UI components with `view`, props, slots, reactivity
- [state](state.md) -- signals and reactive state
- [forms](forms.md) -- forms and validation
- [auth](auth.md) -- authentication and sessions
- [fetch](fetch.md) -- calling APIs and loading data
- [channels](channels.md) -- realtime, WebSockets
- [navigation](navigation.md) -- client navigation, links, history
