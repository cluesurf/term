# The app framework

Build a full application in one language. Server, client, routing, UI, and data are all `.tree`, compiled per target. There is no client/server split to maintain and no virtual DOM. You write `zone` components and a `dock` route table. The framework supplies render, server-side rendering, hydration, navigation, and serving. The environment is swapped underneath, never the app code.

Maps to: Next.js or Remix or SolidStart, but one route table drives both sides and the compiler owns the lowering.

## The pieces

| Piece | Head | What it is | Page |
| --- | --- | --- | --- |
| Component | `zone` | A reactive UI component (signals, real DOM nodes) | [zones](components.md) |
| Reactive state | `make-signal` | A signal: a value plus its observers | [state](state.md) |
| Route table | `dock` | Maps a URL path to a component or handler | [routes](routes.md), [navigation](navigation.md) |
| HTTP handler | `task get` / `task post` | A method handler inside a server `dock` | [routes](routes.md) |
| Request / response | `request` / `response` | The forms an HTTP handler reads and returns | [routes](routes.md) |
| Data fetching | `call` over an endpoint | Loading remote data into a component | [fetch](fetch.md) |
| Forms | `form` in a `zone` | Field declarations, validation, submit | [forms](forms.md) |
| Auth | route handlers + sessions | Login, tokens, sessions, guards | [auth](auth.md) |
| Realtime | `dock /ws/...` | WebSocket connect / message / close | [channels](channels.md) |

## How an app is laid out

A Term app is an ordinary package. Its UI lives in `zone` modules, its routes in a `dock` table, and its server-side logic in `task` handlers. The build compiles the whole tree to `host/`. The same route table is used to render on the server and to navigate on the client.

```
my-app/
  deck.tree          # package manifest
  code/
    boot.tree        # the route table (the dock dispatcher)
    page/            # zone components, one per route
    api/             # server dock handlers
```

## The two boots

The framework's `host` is env-abstracted: one API, two implementations. The app author never writes the split. The compiler lowers the `dock` table into a `route(host, path)` dispatcher that both boots call.

- **Browser boot.** Mount the route's component on the page body, render it, then listen for navigation. Client navigation re-runs the same dispatcher (single-page app), no full reload.
- **Server boot.** Start an HTTP server. For every request, build a fresh in-memory root, run the same `route(host, path)` into it, serialize the tree to HTML, wrap it in the document shell, and respond.

Because both sides call one dispatcher over one component model, there is no `getServerSideProps` versus client-component divide. Write once, the env is swapped under you.

## The request lifecycle (server)

```tree
make request
  bind method, text <GET>
  bind path, text </users/42>
```

1. A request arrives with a `method`, `path`, and `body`.
2. The router (a segment trie) matches the path to a handler and binds path params into a `hash`.
3. For a page route, the handler renders the matched `zone` into an in-memory root, serializes it to HTML, and wraps it in the document shell.
4. For an API route, the `task get` / `task post` handler runs and returns a `response`.
5. A `response` carries a `status` and a `body`.

```tree
make response
  bind status, mark 200
  bind body, text <ok>
```

When no route matches, the router returns a `404` automatically.

## Wiring it together with `term boot`

The compiler turns the `dock` table into a generated `boot(url, port)`. `term boot` finds and runs it.

```bash
term make            # compile .tree to host/ (pages, the dock router, the stylesheet)
term boot            # run the server boot: SSR over the same routes, per request
term boot --port 3000
term halt            # stop running servers
```

The browser build auto-runs its boot when the page loads, mounting and hydrating in place. See [routes](routes.md) for the route table, [zones](components.md) for components, and [the CLI](../toolchain/readme.md) for `boot`, `make`, and friends.

## Pages in this section

- [routes](routes.md) -- declaring routes and HTTP handlers with `dock`
- [zones](components.md) -- UI components with `zone`, props, slots, reactivity
- [state](state.md) -- signals and reactive state
- [forms](forms.md) -- forms and validation
- [auth](auth.md) -- authentication and sessions
- [fetch](fetch.md) -- calling APIs and loading data
- [channels](channels.md) -- realtime, WebSockets, pub-sub
- [navigation](navigation.md) -- client navigation, links, history
