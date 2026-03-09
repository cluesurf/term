# Server Routes

Define HTTP routes with `dock`. Each dock declares a URL path and the
HTTP methods it handles. Parameters use `take`, shared headers use
`fuse`, and handler logic uses `call` with `bind`.

## Basic Route

```tree
dock /health
  task get
    send json
      make health
        bind status, text <ok>
```

## Path Parameters

Declare dynamic segments with `:name` in the path. Use `take path` to
bind them to typed names.

```tree
dock /users/:user
  take path
    take user, name id
      like text

  task get
    call find-user
      bind id, read id
```

Multiple segments:

```tree
dock /teams/:team/members/:member
  take path
    take team, name team-id
      like text
    take member, name member-id
      like text
```

## Query Parameters

Use `take query` to define typed query string parameters.

```tree
dock /users
  task get
    take query
      like hash
        link page, like u32
        link size, like u32
        link sort, like text
          need false
        link filter, like text
          need false

    call list-users
      bind page, read page
      bind size, read size
      bind sort, read sort
      bind filter, read filter
```

With a custom parser for validated input:

```tree
dock /search
  task get
    take query
      like hash
        link q, like text
        link sort, mill query-sort
        link page, like u32
          base mark 1
        link size, like u32
          base mark 20
```

## Request Headers

Declare expected headers inline with `take head`.

```tree
dock /admin
  task get
    take head
      link authorization, like text
      link x-request-id, like text
        need false

    call check-admin
      bind token, read authorization
```

## Shared Headers with Templates

Use `tree` and `fuse` for headers shared across many routes.

```tree
tree auth-head
  take link
    list link

  hook fuse
    take head
      like and
        like hash
          link authorization, like text
          {link}
        like hash
          link x-request-id, like text
            need false
          link x-trace-id, like text
            need false
```

Apply to a route:

```tree
dock /users
  task get
    fuse auth-head
    call list-users

  task post
    fuse auth-head
      link content-type, like text
    call make-user
```

## Request Body

Use `take body` to declare the expected request body shape.

```tree
dock /users
  task post
    take body
      like hash
        link name, like text
        link email, like text
        link role, like text
          need false
          base text <member>

    call make-user
      bind name, read name
      bind email, read email
      bind role, read role
```

With a specific content type:

```tree
dock /upload
  task post
    take body
      like stream
      mill content-type
        bind kind, text <multipart/form-data>
```

## Response Format

Use `send` to declare the response shape.

### JSON Response

```tree
dock /users/:user
  take path
    take user, name id
      like text

  task get
    send json
      like hash
        link id, like text
        link name, like text
        link email, like text
```

### Status Codes

```tree
dock /users
  task post
    take body
      like hash
        link name, like text
        link email, like text

    send json
      seed code, mark 201
      like hash
        link id, like text
        link name, like text

  task delete
    send json
      seed code, mark 204
```

### Multiple Response Types

```tree
dock /export
  task get
    take query
      like hash
        link format, like text

    fork case, read format
      case json
        send json
          like list
      case csv
        send text
          seed head
            link content-type, text <text/csv>
```

## HTTP Methods

Each `task` inside a `dock` maps to an HTTP method.

```tree
dock /posts/:post
  take path
    take post, name id
      like text

  task get
    call find-post
      bind id, read id

  task put
    take body
      like hash
        link title, like text
        link content, like text
    call save-post
      bind id, read id
      bind title, read title
      bind content, read content

  task patch
    take body
      like hash
        link title, like text
          need false
        link content, like text
          need false
    call mold-post
      bind id, read id
      bind title, read title
      bind content, read content

  task delete
    call toss-post
      bind id, read id
```

## Middleware

Use `hook boot` for middleware that runs before every handler in a dock.
Use `hook halt` for cleanup after.

```tree
dock /api
  hook boot
    call check-auth
    call log-request
    call rate-limit

  hook halt
    call log-response

  dock /users
    task get
      call list-users

  dock /posts
    task get
      call list-posts
```

Middleware can also go on individual methods:

```tree
dock /admin/users
  task get
    hook boot
      call check-admin-role
    call list-all-users

  task delete
    hook boot
      call check-super-admin
    call toss-user
```

## Nested Routes

Dock blocks nest to build URL hierarchies.

```tree
dock /api
  dock /v1
    dock /users
      task get
        call list-users

      dock /:user
        take path
          take user, name id
            like text

        task get
          call find-user
            bind id, read id

        dock /posts
          task get
            call list-user-posts
              bind user-id, read id
```

This produces:

- `GET /api/v1/users`
- `GET /api/v1/users/:user`
- `GET /api/v1/users/:user/posts`

## Validation

Use `mill` for input validation on query params, body fields, or
path segments.

```tree
dock /users/:user
  take path
    take user, name id
      like text
      mill uuid

  task put
    take body
      like hash
        link email, like text
          mill email
        link age, like u32
          mill integer
            bind min, mark 0
            bind max, mark 150
        link role, like text
          mill enum
            case admin
            case member
            case guest
```

## Error Responses

Use `bust` to send error responses with specific status codes.

```tree
dock /users/:user
  take path
    take user, name id
      like text

  task get
    save user
      call find-user
        bind id, read id
    fork test
      hook test
        call is-none, read user
      hook hold
        bust not-found
          bind text, text <user not found>
    send json, read user
```

## Redirect

```tree
dock /old-path
  task get
    send back
      seed code, mark 301
      seed head
        link location, text </new-path>
```

## WebSocket Routes

```tree
dock /ws/chat
  task connect
    take query
      like hash
        link room, like text
        link token, like text

    call join-room
      bind room, read room
      bind token, read token

  task read
    take body, like text
    call send-message
      bind text, read body

  task close
    call leave-room
```

## Static Files

```tree
dock /assets
  seed static, text <./public/assets>

dock /favicon.ico
  seed static, text <./public/favicon.ico>
```

## CORS Configuration

```tree
dock /api
  seed cors
    link origin, text <*>
    link method, text <GET, POST, PUT, DELETE>
    link head, text <Authorization, Content-Type>
    link max-age, mark 86400
```

## Rate Limiting

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100

  dock /auth/login
    seed rate
      link window, mark 60000
      link max, mark 5
```

## Full Example

A complete API with shared headers, nested routes, validation,
and middleware.

```tree
tree auth-head
  hook fuse
    take head
      like hash
        link authorization, like text
        link x-request-id, like text
          need false

seed cors
  link origin, text <*>
  link method, text <GET, POST, PUT, DELETE, PATCH>
  link head, text <Authorization, Content-Type>

dock /api/v1
  hook boot
    call log-request
    call parse-auth

  hook halt
    call log-response

  dock /health
    task get
      send json
        make health
          bind status, text <ok>

  dock /users
    task get
      fuse auth-head
      take query
        like hash
          link page, like u32
            base mark 1
          link size, like u32
            base mark 20
          link sort, mill query-sort
          link filter, like text
            need false

      call list-users
        bind page, read page
        bind size, read size
        bind sort, read sort
        bind filter, read filter

    task post
      fuse auth-head
      take body
        like hash
          link name, like text
          link email, like text
            mill email
          link role, like text
            base text <member>
            mill enum
              case admin
              case member
              case guest

      save user
        call make-user
          bind name, read name
          bind email, read email
          bind role, read role

      send json
        seed code, mark 201
        read user

    dock /:user
      take path
        take user, name id
          like text
          mill uuid

      task get
        fuse auth-head
        call find-user
          bind id, read id

      task put
        fuse auth-head
        take body
          like hash
            link name, like text
            link email, like text
              mill email

        call save-user
          bind id, read id
          bind name, read name
          bind email, read email

      task delete
        fuse auth-head
        hook boot
          call check-admin-role
        call toss-user
          bind id, read id
        send json
          seed code, mark 204

      dock /posts
        task get
          fuse auth-head
          take query
            like hash
              link page, like u32
                base mark 1
              link size, like u32
                base mark 20

          call list-user-posts
            bind user-id, read id
            bind page, read page
            bind size, read size

  dock /auth
    seed rate
      link window, mark 60000
      link max, mark 5

    dock /login
      task post
        take body
          like hash
            link email, like text
              mill email
            link password, like text

        save result
          call login
            bind email, read email
            bind password, read password

        fork case, read result
          case okay
            send json
              make session
                bind token, read result/value/token
          case error
            bust unauthorized
              bind text, text <invalid credentials>

    dock /logout
      task post
        fuse auth-head
        call logout
          bind token, read authorization
        send json
          seed code, mark 204
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Route path | `dock /path` | `dock /users` |
| Path param | `:name` + `take path` | `dock /users/:user` |
| Query param | `take query` + `like hash` | `link page, like u32` |
| Request header | `take head` | `link authorization, like text` |
| Request body | `take body` + `like hash` | `link name, like text` |
| HTTP method | `task get/post/put/patch/delete` | `task post` |
| JSON response | `send json` | `send json, read user` |
| Status code | `seed code` | `seed code, mark 201` |
| Response header | `seed head` | `link content-type, text <...>` |
| Nested routes | nested `dock` | `dock /api` / `dock /v1` |
| Middleware | `hook boot` / `hook halt` | `call check-auth` |
| Shared headers | `tree` + `fuse` | `fuse auth-head` |
| Validation | `mill` | `mill email`, `mill uuid` |
| Error response | `bust` | `bust not-found` |
| Redirect | `send back` + `seed code, mark 301` | redirect |
| WebSocket | `task connect/read/close` | `dock /ws/chat` |
| Static files | `seed static` | `seed static, text <./public>` |
| CORS | `seed cors` | `link origin, text <*>` |
| Rate limiting | `seed rate` | `link max, mark 100` |
