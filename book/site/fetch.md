# Fetch (`seed fetch`)

Declarative client-side data loading with caching, revalidation, and
error handling. Define fetch queries inside `zone` blocks. The
framework manages loading states, caching, and retries automatically.

## Basic Fetch

Load data into a zone. The `seed fetch` block declares the URL and
the framework provides `case load`, `case done`, and `case fail`
states.

```tree
zone user-list
  seed fetch, name users
    seed url, text </api/users>

  fork case, read users/state
    case load
      zone span
        text <Loading...>
    case done
      walk list, read users/data
        hook next
          take site, name user
          zone div
            text <read user/name>
    case fail
      zone span
        seed class, text <error>
        read users/error
```

## Fetch with Parameters

Pass dynamic parameters to the fetch URL.

```tree
zone user-detail
  take user-id, like text

  seed fetch, name user
    seed url
      call concat
        bind a, text </api/users/>
        bind b, read user-id

  fork case, read user/state
    case load
      zone span
        text <Loading...>
    case done
      zone div
        zone h1
          read user/data/name
        zone p
          read user/data/email
    case fail
      zone span
        text <User not found>
```

## Cached Query

Enable caching with `seed cache`. The `seed stale` value controls
how long cached data stays fresh (in milliseconds).

```tree
zone product-list
  seed fetch, name products
    seed url, text </api/products>
    seed cache, wave true
    seed stale, mark 60000
    seed key, text <products>

  fork case, read products/state
    case load
      zone span
        text <Loading products...>
    case done
      walk list, read products/data
        hook next
          take site, name product
          zone div
            zone h3
              read product/name
            zone p
              read product/price
```

## Cache with Query Parameters

Use `seed key` with dynamic values to cache different result sets
separately.

```tree
zone search-results
  take query, like text
  take page, like u32

  seed fetch, name results
    seed url
      call concat
        bind a, text </api/search?q=>
        bind b, read query
        bind c, text <&page=>
        bind d
          call to-text
            bind value, read page
    seed cache, wave true
    seed stale, mark 30000
    seed key
      call concat
        bind a, text <search:>
        bind b, read query
        bind c, text <:>
        bind d
          call to-text
            bind value, read page

  fork case, read results/state
    case load
      zone span
        text <Searching...>
    case done
      zone div
        walk list, read results/data/items
          hook next
            take site, name item
            zone div
              read item/title
        zone div
          text <Page >
          read results/data/page
          text < of >
          read results/data/total-pages
```

## Polling

Refetch data on an interval with `seed poll`.

```tree
zone live-stats
  seed fetch, name stats
    seed url, text </api/stats>
    seed poll, mark 5000

  fork case, read stats/state
    case load
      zone span
        text <Loading stats...>
    case done
      zone div
        zone span
          text <Active users: >
          read stats/data/active-users
        zone span
          text <Requests/min: >
          read stats/data/requests-per-min
```

## Retry on Failure

Automatically retry failed requests.

```tree
zone dashboard
  seed fetch, name metrics
    seed url, text </api/metrics>
    seed retry
      seed max, mark 3
      seed delay, mark 1000
      seed backoff, text <exponential>

  fork case, read metrics/state
    case load
      zone span
        text <Loading metrics...>
    case done
      zone div
        read metrics/data
    case fail
      zone div
        zone p
          text <Failed to load metrics>
        zone button
          text <Retry>
          hook click
            call refetch
              bind name, text <metrics>
```

## Dependent Queries

Load data that depends on the result of another fetch. Use
`seed wait` to chain queries.

```tree
zone user-posts
  take user-id, like text

  seed fetch, name user
    seed url
      call concat
        bind a, text </api/users/>
        bind b, read user-id

  seed fetch, name posts
    seed url
      call concat
        bind a, text </api/users/>
        bind b, read user/data/id
        bind c, text </posts>
    seed wait, text <user>

  fork case, read user/state
    case load
      zone span
        text <Loading user...>
    case done
      zone div
        zone h1
          read user/data/name

        fork case, read posts/state
          case load
            zone span
              text <Loading posts...>
          case done
            walk list, read posts/data
              hook next
                take site, name post
                zone div
                  zone h3
                    read post/title
                  zone p
                    read post/body
          case fail
            zone span
              text <Failed to load posts>
    case fail
      zone span
        text <User not found>
```

## Mutation with Refetch

After a mutation (POST, PUT, DELETE), invalidate the cache and
refetch related queries.

```tree
zone todo-list
  seed fetch, name todos
    seed url, text </api/todos>
    seed cache, wave true
    seed key, text <todos>

  fork case, read todos/state
    case done
      walk list, read todos/data
        hook next
          take site, name todo
          zone div
            zone span
              read todo/title
            zone button
              text <Delete>
              hook click
                call fetch-mutate
                  bind url
                    call concat
                      bind a, text </api/todos/>
                      bind b, read todo/id
                  bind method, text <DELETE>
                  halt kink
                call invalidate
                  bind key, text <todos>

  zone form
    save title, text <>
    zone input
      seed value, read title
      hook input
        take site, name event
        save title, read event/value
    zone button
      text <Add>
      hook click
        call fetch-mutate
          bind url, text </api/todos>
          bind method, text <POST>
          bind body
            make todo
              bind title, read title
          halt kink
        save title, text <>
        call invalidate
          bind key, text <todos>
```

## Custom Headers

Pass authentication or custom headers with the fetch.

```tree
zone protected-data
  seed fetch, name data
    seed url, text </api/protected>
    seed head
      link authorization
        call concat
          bind a, text <Bearer >
          bind b, read auth/token
      link x-request-id
        call make-uuid

  fork case, read data/state
    case load
      zone span
        text <Loading...>
    case done
      zone div
        read data/data
    case fail
      zone span
        text <Access denied>
```

## Full Example

A complete data loading pattern with caching, pagination, search,
and mutations.

```tree
zone product-page
  save search, text <>
  save page, mark 1
  save sort, text <name>

  seed fetch, name products
    seed url
      call concat
        bind a, text </api/products?q=>
        bind b, read search
        bind c, text <&page=>
        bind d
          call to-text
            bind value, read page
        bind e, text <&sort=>
        bind f, read sort
    seed cache, wave true
    seed stale, mark 30000
    seed key
      call concat
        bind a, text <products:>
        bind b, read search
        bind c, text <:>
        bind d
          call to-text
            bind value, read page
        bind e, text <:>
        bind f, read sort

  zone search-bar
    zone input
      seed placeholder, text <Search products...>
      seed value, read search
      hook input
        take site, name event
        save search, read event/value
        save page, mark 1

  zone sort-bar
    zone select
      seed value, read sort
      hook change
        take site, name event
        save sort, read event/value
      zone option
        seed value, text <name>
        text <Name>
      zone option
        seed value, text <price>
        text <Price>
      zone option
        seed value, text <date>
        text <Newest>

  fork case, read products/state
    case load
      zone div
        seed class, text <loading>
        text <Loading...>
    case done
      zone div
        walk list, read products/data/items
          hook next
            take site, name product
            zone div
              seed class, text <product-card>
              zone h3
                read product/name
              zone p
                read product/price
              zone button
                text <Add to Cart>
                hook click
                  call fetch-mutate
                    bind url, text </api/cart>
                    bind method, text <POST>
                    bind body
                      make cart-item
                        bind product-id, read product/id
                        bind quantity, mark 1
                    halt kink

      zone div
        seed class, text <pagination>
        zone button
          seed disabled
            call is-maximum
              bind a, mark 1
              bind b, read page
          text <Previous>
          hook click
            save page
              call subtract
                bind a, read page
                bind b, mark 1
        zone span
          text <Page >
          call to-text
            bind value, read page
        zone button
          seed disabled
            call is-minimum
              bind a, read products/data/total-pages
              bind b, read page
          text <Next>
          hook click
            save page
              call add
                bind a, read page
                bind b, mark 1

    case fail
      zone div
        zone p
          text <Failed to load products>
        zone button
          text <Retry>
          hook click
            call refetch
              bind name, text <products>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Fetch definition | `seed fetch, name x` | `seed fetch, name users` |
| URL | `seed url` | `seed url, text </api/users>` |
| Loading state | `case load` | `fork case, read x/state` |
| Success state | `case done` | `read x/data` |
| Error state | `case fail` | `read x/error` |
| Cache | `seed cache` | `seed cache, wave true` |
| Stale time | `seed stale` | `seed stale, mark 60000` |
| Cache key | `seed key` | `seed key, text <users>` |
| Polling | `seed poll` | `seed poll, mark 5000` |
| Retry | `seed retry` | `seed max, mark 3` |
| Dependent query | `seed wait` | `seed wait, text <user>` |
| Custom headers | `seed head` + `link` | `link authorization, read token` |
| Refetch | `call refetch` | `bind name, text <x>` |
| Invalidate cache | `call invalidate` | `bind key, text <x>` |
| Mutation | `call fetch-mutate` | `bind method, text <POST>` |
