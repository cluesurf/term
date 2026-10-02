# Navigation

Client navigation runs the same [route table](routes.md) without a full page reload. A same-origin link click updates the URL through the browser History API, then the dispatcher re-runs `route(host, path)` and swaps the matched [view](components.md) into place. One route table, one dispatcher, used on the server for the first paint and on the client for every move after.

Maps to: a single-page-app router (React Router, Solid Router), but it shares the exact route table the server renders from.

## Cheatsheet

| Piece | How |
| --- | --- |
| Page route | `hook /path` mapping to a `view` |
| Layout | a parent `view` with `site`, each page placing its content inside it |
| A link | an `a` element with `seed href` (intercepted for SPA nav) |
| Back / forward | the browser's own buttons. `host` listens for `popstate` |
| Navigate in code | not provided. There is no `navigate` task |
| Guard | a branch in a `route` task of your own |

## The client route table

The same `hook` table that the server renders from maps paths to components in the browser. Props pass in with `bind`.

```tree
load @term/site/code/dom/dom
  find view

view home-page
  take host, like view
  view h1
    text <Home>

view about-page
  take host, like view
  view h1
    text <About>

view user-page
  take host, like view
  take id, like text
  view p
    read id

hook /
  view home-page

hook /about
  view about-page

hook /users/42
  view user-page
    bind id, text <42>
```

A page route matches its path exactly, so there is no `:id` segment and no catch-all 404 page on the client. See [routes](routes.md).

## Layouts

A parent `view` with a `site` is a layout. A page places its own content inside the layout, so shared chrome (nav, footer) is written once. Page routes do not nest, so each page names its layout.

```tree
load @term/site/code/dom/dom
  find view

view main-layout
  take host, like view
  view nav
    view a
      seed href, text </>
      text <Home>
  site
  view footer
    text <Term>

view home-page
  take host, like view
  view main-layout
    view h1
      text <Home>

hook /
  view home-page
```

## Links

A link is an anchor element with an `href`. In the browser, `host` intercepts a click on an `<a>` whose `href` starts with `/` and points at the same host, pushes the path onto history, and re-runs the dispatcher instead of reloading.

```tree
load @term/site/code/dom/dom
  find view

view site-nav
  take host, like view
  view a
    seed href, text </about>
    text <About>
  view a
    seed href, text </users/42>
    text <A user>
```

## Navigating in code

There is no `navigate` task. `@term/site/code/dom/page` provides `page-path` (the current path) and `listen-pop` (run a task on back, forward, and an intercepted link click), and nothing that pushes a path from code. To move after a save, render a link, or let the handler's result decide what the current page shows.

## Guards and redirects

A guard is a branch in a `route` task of your own: check the condition, then mount one page or another for the same path. This is how a `/settings` route shows the login page to an anonymous visitor. The auth state itself comes from your own session store (see [auth](auth.md)).

```tree
load @term/site/code/dom/dom
  find view

view settings-page
  take host, like view
  view h1
    text <Settings>

view login-page
  take host, like view
  view h1
    text <Sign in>

task route
  take host, like view
  take path, like text
  take signed-in, like boolean
  fork test
    hook test
      call is-equal
        read path
        text </settings>
    hook hold
      fork test
        hook test
          read signed-in
        hook hold
          call settings-page
            read host
        hook miss
          call login-page
            read host
```

## How it stays in sync

On the server, the boot renders the matched view to HTML so the first paint arrives as markup. On the client, the boot clears that markup and renders the page again (there is no hydration yet), then listens for navigation. A history change re-runs the same dispatcher into the cleared body. Because both sides drive one table, there is no separate client and server routing to keep aligned. See [routes](routes.md) for the table and [the framework overview](readme.md) for the lifecycle.
