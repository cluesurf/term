# Navigation

Client navigation runs the same [route table](routes.md) without a full page reload. A link or a `navigate` call updates the URL through the browser History API, then the dispatcher re-runs `route(host, path)` and swaps the matched [zone](components.md) into place. One route table, one dispatcher, used on the server for the first paint and on the client for every move after.

Maps to: a single-page-app router (React Router, Solid Router), but it shares the exact route table the server renders from.

## Cheatsheet

| Piece | How |
| --- | --- |
| Page route | `dock /path` mapping to a `zone` |
| Dynamic segment | `dock /users/:id` with `take path` |
| Catch-all / 404 | `dock /**` to a fallback zone |
| Layout | a parent `zone` with `site`, nested `dock` children render into it |
| A link | an `a` element with `bind href` (intercepted for SPA nav) |
| Navigate in code | `call navigate` with `bind path` |
| Back / forward | `call navigate` with `bind back` / `bind forward` |
| Guard | a check task that runs before the zone mounts |
| Redirect | navigate to another path, or a guard redirects on failure |

## The client route table

The same `dock` table that serves the server maps paths to components for the browser. Params flow in as props.

```tree
dock /
  zone home-page

dock /about
  zone about-page

dock /users/:id
  take path
    take id
      like text
  zone user-detail
    bind id, read id

dock /**
  zone not-found-page
```

## Layouts

A parent `zone` with a `site` is a layout. Nested `dock` children render into the site, so shared chrome (nav, footer) stays mounted while the inner page changes.

```tree
zone main-layout
  take host, like view
  zone nav-bar
  site
  zone footer
```

```tree
dock /
  zone main-layout
    dock /
      zone home-page
    dock /about
      zone about-page
```

## Links

A link is an anchor element with an `href`. The framework intercepts a same-origin click, updates history, and re-runs the dispatcher instead of reloading.

```tree
zone nav
  take host, like view
  zone a
    bind href, text </about>
    text <About>
  zone a
    bind href, text </users/42>
    text <A user>
```

## Navigating in code

Call `navigate` from a handler to move programmatically, for example after a successful save.

```tree
task finish-login
  call login
    bind data, read form
    halt kink
  call navigate
    bind path, text </dashboard>
```

Go back or forward through history:

```tree
task go-back
  call navigate
    bind back, true
```

## Guards and redirects

A guard is a check that runs before a route's zone mounts. If it fails, the guard redirects. The check is an ordinary task returning a boolean, and the redirect is a `navigate` to another path. This is how a `/settings` route sends an anonymous visitor to `/login` and a `/login` route sends a signed-in user to `/`. The auth state itself comes from a session or token (see [auth](auth.md)).

## How it stays in sync

On the server, the boot renders the matched zone to HTML so the first paint is instant. On the client, the boot mounts onto that HTML, hydrates it in place (no re-render flash), then listens for navigation. A history change re-runs the same dispatcher, disposing the old view's [scope](state.md) and mounting the new one. Because both sides drive one table, there is no separate client and server routing to keep aligned. See [routes](routes.md) for the table and [the framework overview](readme.md) for the lifecycle.
