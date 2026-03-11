# Client-Side Navigation

Define client-side routes with `seed route`. Each `dock` declares a URL
path and maps it to a component with `zone`. Dynamic segments use
`take path`, guards use `seed guard`, and redirects use `seed redirect`.

## Basic Routes

Map paths to components with `dock` and `zone`.

```tree
seed route
  dock /
    zone home-page

  dock /about
    zone about-page

  dock /login
    zone login-page
```

## Dynamic Segments

Declare dynamic segments with `:name` in the path. Use `take path` to
bind them to typed names.

```tree
seed route
  dock /users/:id
    take path
      take id, like text
    zone user-detail
      bind id, read id
```

Multiple segments:

```tree
seed route
  dock /teams/:team/members/:member
    take path
      take team, like text
      take member, like text
    zone member-detail
      bind team, read team
      bind member, read member
```

## Nested Routes

Nest `dock` blocks inside a `zone` to build route hierarchies with
shared layouts.

```tree
seed route
  dock /admin
    zone admin-layout
      dock /
        zone admin-dashboard
      dock /users
        zone admin-users
      dock /settings
        zone admin-settings
```

This produces:

- `/admin` renders `admin-layout` with `admin-dashboard`
- `/admin/users` renders `admin-layout` with `admin-users`
- `/admin/settings` renders `admin-layout` with `admin-settings`

## Route Guards

Use `seed guard` to protect routes with a check function. The guard
function runs before the component renders. If it returns false, the
route is blocked.

```tree
seed route
  dock /login
    seed guard, call is-guest
    zone login-page

  dock /settings
    seed guard, call is-logged-in
    zone settings-page

  dock /admin
    seed guard, call is-admin
    zone admin-layout
      dock /
        zone admin-dashboard
```

Guards on nested routes apply after parent guards:

```tree
seed route
  dock /admin
    seed guard, call is-logged-in
    zone admin-layout
      dock /users
        seed guard, call is-admin
        zone admin-users
```

A guard can redirect on failure:

```tree
seed route
  dock /settings
    seed guard, call is-logged-in
      seed redirect, text </login>
    zone settings-page
```

## Redirects

Use `seed redirect` to send a path to a different location.

```tree
seed route
  dock /old-path
    seed redirect, text </new-path>

  dock /legacy/dashboard
    seed redirect, text </admin>
```

## Catch-All and 404 Routes

Use `dock /*` to match any unmatched path.

```tree
seed route
  dock /
    zone home-page

  dock /about
    zone about-page

  dock /*
    zone not-found-page
```

A catch-all can also capture the matched path:

```tree
seed route
  dock /*
    take path
      take rest, like text
    zone not-found-page
      bind path, read rest
```

## Query Parameters

Use `take query` to declare typed query string parameters.

```tree
seed route
  dock /search
    take query
      like hash
        link q, like text
        link page, like u32
          base mark 1
        link sort, like text
          need false
    zone search-page
      bind query, read q
      bind page, read page
      bind sort, read sort
```

## Programmatic Navigation

Use `call navigate` to change routes from within component logic.

```tree
task handle-login
  call login
    bind email, read email
    bind password, read password
    halt kink
  call navigate
    bind path, text </settings>
```

Navigate with parameters:

```tree
task view-user
  take id, like text
  call navigate
    bind path, text </users>
    bind param
      bind id, read id
```

Go back or forward:

```tree
task go-back
  call navigate
    bind back, wave true

task go-forward
  call navigate
    bind forward, wave true
```

## Route Transitions and Loading States

Use `seed load` to display a loading component while route data loads.
Use `seed fail` for error states.

```tree
seed route
  dock /users/:id
    take path
      take id, like text
    seed load
      zone loading-spinner
    seed fail
      zone error-page
    zone user-detail
      bind id, read id
```

Transitions between routes:

```tree
seed route
  seed transition
    bind kind, text <fade>
    bind time, mark 200

  dock /
    zone home-page
  dock /about
    zone about-page
```

## Layouts

Use a parent `zone` with nested `dock` children to share UI across
routes. The parent component renders shared elements and a slot for
child content.

```tree
seed route
  dock /
    zone main-layout
      dock /
        zone home-page
      dock /about
        zone about-page
      dock /contact
        zone contact-page

  dock /admin
    zone admin-layout
      dock /
        zone admin-dashboard
      dock /reports
        zone admin-reports
```

The layout component uses `slot` to render the active child route:

```tree
zone main-layout
  zone nav-bar
  slot
  zone footer
```

## Full Example

A complete client-side route tree with guards, nested layouts, dynamic
segments, and a catch-all.

```tree
seed route
  seed transition
    bind kind, text <fade>
    bind time, mark 150

  dock /
    zone main-layout
      dock /
        zone home-page
      dock /about
        zone about-page
      dock /search
        take query
          like hash
            link q, like text
            link page, like u32
              base mark 1
        zone search-page
          bind query, read q
          bind page, read page

  dock /login
    seed guard, call is-guest
      seed redirect, text </>
    zone login-page

  dock /settings
    seed guard, call is-logged-in
      seed redirect, text </login>
    zone settings-page

  dock /users/:id
    take path
      take id, like text
    seed load
      zone loading-spinner
    zone user-detail
      bind id, read id

  dock /admin
    seed guard, call is-admin
      seed redirect, text </>
    zone admin-layout
      dock /
        zone admin-dashboard
      dock /users
        zone admin-users
      dock /settings
        zone admin-settings

  dock /old-dashboard
    seed redirect, text </admin>

  dock /*
    zone not-found-page
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Route tree | `seed route` | top-level route declaration |
| Route path | `dock /path` | `dock /users` |
| Component | `zone name` | `zone home-page` |
| Dynamic segment | `:name` + `take path` | `dock /users/:id` |
| Query param | `take query` + `like hash` | `link q, like text` |
| Nested routes | `dock` inside `zone` | `zone layout` / `dock /child` |
| Route guard | `seed guard, call fn` | `seed guard, call is-admin` |
| Guard redirect | `seed redirect` inside guard | `seed redirect, text </login>` |
| Redirect | `seed redirect, text <path>` | `seed redirect, text </new>` |
| Catch-all | `dock /*` | `dock /*` / `zone not-found-page` |
| Loading state | `seed load` | `seed load` / `zone spinner` |
| Error state | `seed fail` | `seed fail` / `zone error-page` |
| Transition | `seed transition` | `bind kind, text <fade>` |
| Layout | parent `zone` with nested `dock` | `zone layout` / `dock /` |
| Layout slot | `slot` | renders active child route |
| Navigate | `call navigate` | `bind path, text </home>` |
| Go back | `call navigate` + `bind back` | `bind back, wave true` |
