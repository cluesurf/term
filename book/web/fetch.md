# Fetch

Loading remote data is an async [call](../language/async.md) whose result you hold in a [signal](state.md). A request is in one of three states: loading, done, or failed. A [zone](components.md) reads the state and renders the matching view. The data layer adds caching, revalidation, and retries on top of this, but the base shape is a signal plus a `fork case`.

Maps to: TanStack Query / SWR, but the query state is a plain signal and the fetch is a plain async call.

## Cheatsheet

| Piece | How |
| --- | --- |
| Issue a request | `call fetch` (async) over a URL, with `note async` |
| Hold the result | a [signal](state.md) of a query state |
| Loading branch | `case load` |
| Success branch | `case done`, read the data |
| Failure branch | `case fail`, read the error |
| Send a body | `bind method` plus `bind body` on the call |
| Custom headers | `bind head` with `link` children |
| Re-run a query | call the loader again |
| Mutate then refresh | run the mutation, then re-run the affected loader |

## A basic fetch

A loader is an async task. It writes a loading state, awaits the request, then writes done or failed. A zone reads the state.

```tree
form query
  head t
  case load
  case done
    link value, like t
  case fail
    link error, like text

task load-users
  take state, like signal
  note async
  call write-signal
    bind self, read state
    bind value
      make load
  save result
    call fetch
      bind url, text </api/users>
      note async
  fork case, read result
    case okay
      call write-signal
        bind self, read state
        bind value
          make done
            bind value, read result/value
    case error
      call write-signal
        bind self, read state
        bind value
          make fail
            bind error, read result/text
```

## Rendering the states

The component holds the state signal and switches on it.

```tree
zone user-list
  take host, like view
  save state
    call make-signal
      bind value
        make load
  fork case
    call read-signal
      bind self, read state
    case load
      zone span
        text <Loading...>
    case done
      take value
      zone ul
        walk list, read value
          hook next
            take site, name user
            zone li
              read
                read user/name
    case fail
      take error
      zone span
        bind class, text <error>
        read error
```

## Fetch with parameters

Build the URL from props or signals before the call.

```tree
save url
  call join
    text </api/users/>
    read user-id
save result
  call fetch
    bind url, read url
    note async
```

## Sending a body

For a mutation, set the method and body on the call.

```tree
call fetch
  bind url, text </api/todos>
  bind method, text <POST>
  bind body
    call to-json
      make todo
        bind title, read title
  note async
  halt kink
```

## Custom headers

Pass headers, for example a bearer token, with `bind head`.

```tree
call fetch
  bind url, text </api/protected>
  bind head
    link authorization
      call join
        text <Bearer >
        read token
  note async
```

## Caching and revalidation

A query layer wraps the base loader to add caching by key, a stale window, polling, retries, and cache invalidation. The pattern: give a query a stable key, serve cached data while it is fresh, refetch in the background when stale, and invalidate the key after a mutation so dependent views reload. The same loader runs on the server (for the initial render) and on the client (on navigation), so the data is fetched once and reused. See [the framework overview](readme.md) for how a route's data is serialized into the page and reused by the client.

## Mutations

After a POST, PUT, or DELETE, re-run the loaders whose data changed so the UI reflects the new state. With a cache, this is invalidating the affected keys. Without one, it is calling the loader again. Use `halt kink` on the mutation call to propagate a failure to the surrounding handler.
