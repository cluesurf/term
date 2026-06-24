# Routes

A route table maps URL paths to handlers. The same `dock` head declares both server endpoints (an HTTP method runs a `task`) and client pages (a path mounts a `zone`). The matcher is a segment trie, so a lookup is O(path-depth) no matter how many routes you register. Static, `:param`, and catch-all segments are all supported.

Maps to: an Express or Fastify router on the server, plus a client router like React Router or Solid Router, expressed as one table.

## Cheatsheet

| Form | Job |
| --- | --- |
| `dock /path` | Declare a route at a path |
| nested `dock` | Build a URL hierarchy (paths concatenate) |
| `dock /users/:id` | A dynamic segment, bound by name |
| `dock /files/**` | A catch-all, binds the joined rest of the path |
| `take path` | Bind path params to typed names |
| `task get` / `task post` / `task put` / `task patch` / `task delete` | A method handler inside a server `dock` |
| `task connect` / `task read` / `task close` | A WebSocket handler (see [channels](channels.md)) |
| `take request, like request` | The incoming request (`method`, `path`, `body`) |
| `take params, like hash` | The matched path params |
| `make response` | Build the reply (`status`, `body`) |
| `zone <name>` | Mount a component (a client page route) |
| `bust <error>` | Send an error response |

## Request and response

A handler reads a `request` and returns a `response`. These are plain forms.

```tree
form request
  link method, like text
  link path, like text
  link body, like text

form response
  link status, like number
  link body, like text
```

A minimal handler:

```tree
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

Each `task` inside a `dock` is one HTTP method. The verb is the task name.

```tree
dock /health
  task get
    send back
      make response
        bind status, code 200
        bind body, text <ok>
```

A resource with several methods:

```tree
dock /posts
  task get
    send back
      call list-posts
  task post
    send back
      call make-post
        read request/body
```

## Path parameters

Declare a dynamic segment with `:name`. Bind it with `take path`. The matched value arrives in the `params` hash, keyed by the segment name.

```tree
dock /users/:id
  take path
    take id
      like text
  task get
    save who
      call get
        read params
        text <id>
    send back
      call find-user
        read who
```

Multiple segments concatenate as you nest:

```tree
dock /teams/:team
  dock /members/:member
    task get
      call find-member
        call get
          read params
          text <team>
        call get
          read params
          text <member>
```

## Catch-all segments

A `*` or `**` segment matches the remaining path and binds the joined segments. With no name it binds `rest`.

```tree
dock /files/**
  take path
    take rest
      like text
  task get
    call serve-file
      call get
        read params
        text <rest>
```

The trie matches the most specific branch first. A static child wins over a `:param` child, which wins over a catch-all. So `/base/**` (assets) is matched before `/**` (pages).

## Client page routes

The same `dock` table maps a path to a `zone` component for the browser. Params flow into the component as props with `bind`.

```tree
dock /
  zone home-page

dock /counter
  zone counter
    bind label, text <hits>

dock /users/:id
  take path
    take id
      like text
  zone user-detail
    bind id, read id
```

A catch-all page is the 404:

```tree
dock /**
  zone not-found-page
```

## Errors

Return an error status directly, or `bust` to throw one.

```tree
dock /users/:id
  task get
    save user
      call find-user
        call get
          read params
          text <id>
    fork test
      hook test
        call is-none, read user
      hook hold
        bust not-found
          bind text, text <user not found>
    send back
      make response
        bind status, code 200
        bind body
          call to-json, read user
```

## How it dispatches

The build collects every `dock` into one route table and lowers it to a `route(host, path)` dispatcher plus, on the server, a trie built once with `route-server`. A request flows through `handle-request`: split the path, walk the trie, bind params, call the matched handler. A page route renders its `zone` into an in-memory root and serializes it. See [navigation](navigation.md) for how the client side re-runs the same dispatcher, and [the framework overview](readme.md) for the full lifecycle.
