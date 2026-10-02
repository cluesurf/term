# Fetch

Loading remote data is an async [call](../language/async.md) whose result you hold in a [signal](state.md). A request is in one of three states: loading, done, or failed. A [view](components.md) reads the state and renders the matching branch. The request is a call to `@term/base/code/network/http`, and its answer is an `http-response` with a `status`, a `body` and `headers` (lower-case names, in code point order). A request waits 30,000 milliseconds unless given a `timeout`, then raises `timeout`; a server that cannot be reached raises `outage`. Any status is an answer, not a raise.

Maps to: a hand-written `fetch` plus `useState`. There is no query layer, cache, or retry on top of it yet.

## Cheatsheet

| Piece | How |
| --- | --- |
| Issue a request | `call fetch` with the URL, and `wait true` under the call |
| Mark the loader | `note async` on the task that makes the request |
| Hold the result | a [signal](state.md) of the body, and one of the status |
| Loading, done, failed | a `fork test` on the status signal |
| Send a body | `call post` with the URL and the body, or `call request` with any method |
| Custom headers | a `hash` of text to text, passed as the last argument |
| Re-run a query | call the loader again |
| Mutate then refresh | run the mutation, then re-run the affected loader |

## A basic fetch

A loader is an async task. It writes a loading state, awaits the request, then writes done or failed.

```tree
load @term/base/code/network/http
  find fetch

load @term/site/code/view/reactive
  find signal
  find write-signal

task load-users
  take status, like signal text
  take body, like signal text
  note async
  call write-signal
    bind self, read status
    bind value, text <loading>
  save answer
    call fetch
      text </api/users>
      wait true
  fork test
    hook test
      call is-above
        read answer/status
        code 299
    hook hold
      call write-signal
        bind self, read status
        bind value, text <failed: {{answer/status}}>
    hook miss
      call write-signal
        bind self, read body
        bind value, read answer/body
      call write-signal
        bind self, read status
        bind value, text <done>
```

## Rendering the states

The component reads the status signal and switches on it.

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find signal
  find read-signal

view user-list
  take host, like view
  take status, like signal text
  take body, like signal text
  fork test
    hook test
      call is-equal
        call read-signal, read status
        text <loading>
    hook hold
      view span
        text <Loading...>
    hook miss
      fork test
        hook test
          call is-equal
            call read-signal, read status
            text <done>
        hook hold
          view pre
            read
              call read-signal, read body
        hook miss
          view span
            seed class, text <error>
            read
              call read-signal, read status
```

A `fork test` inside a view takes one `hook test` and `hook hold` pair and a `hook miss`. A second pair compiles and is dropped, so a third branch nests inside the `hook miss`.

The page renders on the server once and is sent. An answer that lands later never reaches that response, so a crawler sees `Loading...`. A route-level loader that runs before render is designed in `note/term/ssr-framework.md` and not built.

## Fetch with parameters

Build the URL from props or signals before the call.

```tree
load @term/base/code/network/http
  find fetch

task load-user
  take user-id, like text
  like text
  note async
  save answer
    call fetch
      text </api/users/{{user-id}}>
      wait true
  send back, read answer/body
```

## Sending a body

For a mutation, `post` takes the URL and the body. `request` takes any method.

```tree
load @term/base/code/network/http
  find post
  find request

task add-todo
  take title, like text
  like number
  note async
  save answer
    call post
      text </api/todos>
      text <{"title":"{{title}}"}>
      wait true
  send back, read answer/status

task remove-todo
  take id, like text
  like number
  note async
  save answer
    call request
      text <DELETE>
      text </api/todos/{{id}}>
      text <>
      wait true
  send back, read answer/status
```

## Custom headers

Pass headers, for example a bearer token, as a `hash` of text to text.

```tree
load @term/base/code/network/http
  find fetch

task load-protected
  take token, like text
  like text
  note async
  save header
    make hash
  call header/set
    text <authorization>
    text <Bearer {{token}}>
  save answer
    call fetch
      text </api/protected>
      read header
      wait true
  send back, read answer/body
```

An `http-response` holds the status and the body only. Response headers are not read yet.

## Caching and revalidation

There is no query layer. Caching by key, a stale window, polling, retries, and invalidation are not provided. A loader that wants them keeps its own `hash` from URL to body and checks it before the call.

## Mutations

After a POST, PUT, or DELETE, re-run the loaders whose data changed so the UI reflects the new state. Without a cache, this is calling the loader again.
