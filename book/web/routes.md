# Routes

Routing comes in two halves, built differently. A **page route** is a `hook` line whose path starts with `/`, and the compiler lowers every one in a file into a `route(host, path)` dispatcher that mounts a [view](components.md). A **server route** is a `route` record (a method, a path, and a handler task) handed to the trie router in `@term/site/code/http/http` at run time. The matcher is a segment trie, so a lookup is O(path-depth) no matter how many routes you register. Static, `:param`, and catch-all segments are all supported on the server side.

The route head was `dock /path` until 2026-08-31. `dock` is now only the native binding (`dock load`, `dock type`), and a `dock /path` line is refused with a message saying so.

Maps to: an Express or Fastify router on the server, plus a client router like React Router or Solid Router.

## Cheatsheet

| Form | Job |
| --- | --- |
| `hook /path` with a `view <name>` child | A page route: mount a component at a path |
| `bind <prop>, <value>` under the `view` | Pass a prop to the page component |
| `make route` with `method`, `path`, `handle` | A server route |
| `/users/:id` in a server route's path | A dynamic segment, bound by name |
| `/files/**` in a server route's path | A catch-all, binds the joined rest of the path |
| `take request, like request` | The incoming request (`method`, `path`, `body`) |
| `take params, like hash` | The matched path params |
| `make response` | Build the reply (`status`, `body`) |
| `call route-server` | Build the trie from a list of routes |
| `call serve` | Listen on a port |

## Request and response

A handler reads a `request` and returns a `response`. These are plain forms in `@term/site/code/http/http`:

```tree
form request
  link method, like text
  link path, like text
  link body, like text

form response
  link status, like u16
  link body, like text
```

A request carries no headers yet, and a response carries a status and a body only.

A minimal handler:

```tree
load @term/site/code/http/http
  find request
  find response

task handle
  take request, like request
  take params, like hash
  like response
  send back
    make response
      bind status, code 200
      bind body, text <ok>
```

## A server route

A route record names the HTTP method, the path, and the handler task. Collect the records in a list, build the trie once with `route-server`, and hand it to `serve`.

```tree
load @term/site/code/http/http
  find request
  find response
  find route
  find route-server

load @term/site/code/http/serve
  find serve

load @term/base/code/list
  find list
  find push

task health
  take request, like request
  take params, like hash
  like response
  send back
    make response
      bind status, code 200
      bind body, text <ok>

task boot
  take url, like text
  take port, like u16
  note async
  save routes
    make list
  call push
    bind list, read routes
    bind item
      make route
        bind method, text <GET>
        bind path, text </health>
        bind handle, read health
  call serve
    call route-server
      read routes
    read port
```

A resource with several methods is several records on one path:

```tree
load @term/site/code/http/http
  find request
  find response
  find route

load @term/base/code/list
  find list
  find push

task list-posts
  take request, like request
  take params, like hash
  like response
  send back
    make response
      bind status, code 200
      bind body, text <[]>

task make-post
  take request, like request
  take params, like hash
  like response
  send back
    make response
      bind status, code 201
      bind body, read request/body

task post-routes
  like list
  save routes
    make list
  call push
    bind list, read routes
    bind item
      make route
        bind method, text <GET>
        bind path, text </posts>
        bind handle, read list-posts
  call push
    bind list, read routes
    bind item
      make route
        bind method, text <POST>
        bind path, text </posts>
        bind handle, read make-post
  send back, read routes
```

## Path parameters

Declare a dynamic segment with `:name` in the route's path. The matched value arrives in the `params` hash, keyed by the segment name.

```tree
load @term/site/code/http/http
  find request
  find response

load @term/base/code/hash
  find get, name hash-get

load @term/base/code/maybe
  find unwrap-or

# GET /users/:id answers the id it was given
task show-user
  take request, like request
  take params, like hash
  like response
  save id
    call unwrap-or
      call hash-get
        read params
        text <id>
      text <>
  send back
    make response
      bind status, code 200
      bind body, text <{"id":"{{id}}"}>
```

A path with two segments, `/teams/:team/members/:member`, binds both names into the same hash.

## Catch-all segments

A `*` or `**` segment matches the remaining path and binds the joined segments. With no name it binds `rest`, so a route on `/files/**` reads `rest` out of `params` the way `show-user` reads `id`.

The trie matches the most specific branch first. A static child wins over a `:param` child, which wins over a catch-all. So `/base/**` (assets) is matched before `/**` (pages). A path no route matches answers 404.

## Client page routes

A `hook` whose path starts with `/` places a component, with `bind` lines for its props. Write the path bare, `hook /about`. The spelling `hook </about>` fails.

```tree
load @term/site/code/dom/dom
  find view

view home-page
  take host, like view
  view h1
    text <Home>

view counter
  take host, like view
  take label, like text
  view p
    read label

hook /
  view home-page

hook /counter
  view counter
    bind label, text <hits>
```

**A page route matches its path exactly.** `hook /users/:id` compiles, and only the literal text `/users/:id` reaches it. There is no catch-all page either: an unknown page path renders an empty body with status 200. A page that reads a segment out of its path is written as a `route` task of your own, as in [the framework overview](readme.md).

## Errors

A handler answers an error by returning a response with an error status.

```tree
load @term/site/code/http/http
  find request
  find response

load @term/base/code/hash
  find has, name hash-has

task user-or-missing
  take request, like request
  take params, like hash
  like response
  fork test
    hook test
      call hash-has
        read params
        text <id>
    hook hold
      send back
        make response
          bind status, code 200
          bind body, text <found>
  send back
    make response
      bind status, code 404
      bind body, text <user not found>
```

## How it dispatches

The build collects every page `hook` in a file and lowers them to a `route(host, path)` dispatcher, one branch per line. On the server, `route-server` builds the trie once from the route records. A request flows through `handle-request`: split the path, walk the trie, bind params, call the matched handler. See [navigation](navigation.md) for how the client side re-runs the same dispatcher, and [the framework overview](readme.md) for the full lifecycle.
