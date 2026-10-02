# State

State is reactive. A **signal** holds a value and its observers. Reading a signal inside an effect subscribes that effect. Writing the signal re-runs its subscribers. A reactive text node or attribute in a [view](components.md) is just an effect, so it patches in place when a signal it reads changes. This is the Solid model: run-once setup, no virtual DOM, no re-render.

Maps to: SolidJS signals and effects (`createSignal`, `createEffect`, `createMemo`, `batch`, `untrack`, `onMount`, `onCleanup`).

## Cheatsheet

| Task | Job |
| --- | --- |
| `make-signal` | Create a signal holding an initial value |
| `read-signal` | Read a signal (subscribes the running effect) |
| `write-signal` | Write a signal (re-runs its observers) |
| `make-effect` | Run a task now and again whenever a signal it reads changes |
| `make-memo` | A derived, cached value that recomputes only on dependency change |
| `make-root` | Run a body in a fresh ownership scope and return its handle |
| `batch` | Run many writes as one update pass (effects fire once) |
| `untrack` | Read signals without subscribing the running effect |
| `on-mount` | Run a body once, untracked, after setup |
| `on-cleanup` | Register a cleanup to run when the current scope is disposed |

The signal is generic, `like signal t`, so a signal of text and a signal of numbers are two types.

## Import

```tree
load @term/site/code/view/reactive
  find signal
  find make-signal
  find read-signal
  find write-signal
  find make-effect
  find make-memo
```

## Signals

Create with an initial value, read with `read-signal`, write with `write-signal`.

```tree
load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

task signal-tour
  like number
  save count
    call make-signal
      bind value, code 0

  # read
  save now
    call read-signal
      bind self, read count

  # write
  call write-signal
    bind self, read count
    bind value, code 5

  send back, read now
```

A write inside a click handler, reading the old value to increment:

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find signal
  find make-signal
  find read-signal
  find write-signal

task bump
  take count, like signal number
  call write-signal
    bind self, read count
    bind value
      call add
        call read-signal
          bind self, read count
        code 1

view clicker
  take host, like view
  save count
    call make-signal
      code 0
  view button
    hook click, call bump(read count)
    read
      call read-signal, read count
```

Any `read` in a [view](components.md) bound to that signal updates when it changes. Nothing else re-renders.

## Effects

`make-effect` runs a task once, tracking the signals it reads, then re-runs whenever any of them change.

```tree
load @term/site/code/view/reactive
  find signal
  find read-signal
  find make-effect

load @term/base/code/console
  find log

task watch-count
  take count, like signal number
  call make-effect
    bind run
      task log-count
        call log
          text <count is {{read-signal(read count)}}>
```

The render runtime builds on effects: a reactive text node and a reactive attribute are both effects the framework creates for you.

## Memos

A memo is a derived value cached in a signal. It recomputes only when a dependency changes, so downstream effects do not re-run on unrelated updates. Read it with `read-signal`.

```tree
load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find make-memo

host count
  call make-signal
    code 0

host doubled
  call make-memo
    bind compute
      task twice
        like number
        send back
          call multiply
            call read-signal
              bind self, read count
            code 2
```

## Batching

`batch` defers effect runs until the body completes, so many writes cause one update pass instead of one per write.

```tree
load @term/site/code/view/reactive
  find signal
  find write-signal
  find batch

task set-both
  take first, like signal number
  take second, like signal number
  call batch
    bind body
      task many
        call write-signal
          bind self, read first
          bind value, code 1
        call write-signal
          bind self, read second
          bind value, code 2
```

## Untracked reads and mount

`untrack` reads signals without subscribing the running effect. `on-mount` runs a body once, untracked, for post-setup side effects (it does not re-run on change).

```tree
load @term/site/code/dom/dom
  find view
  find focus

load @term/site/code/view/reactive
  find on-mount

view search-box
  take host, like view
  view input
    name field
  call on-mount
    bind body
      task setup
        call focus
          read field
```

## Scopes and cleanup

A scope (an owner) groups the effects created while it is open, plus cleanup tasks to run when it is disposed. Disposing a scope stops its effects and runs its cleanups, so a view region tears down with no leaks. Use `on-cleanup` to release a listener, timer, or observer when its region unmounts.

```tree
load @term/site/code/view/reactive
  find on-cleanup

load @term/base/code/console
  find log

task watch-region
  call on-cleanup
    bind run
      task stop
        call log
          text <region disposed>
```

`make-root` opens a fresh scope, runs a body inside it, and returns the scope handle so a caller can pass it to `dispose-scope` later. The framework opens and disposes scopes around mounted regions for you, so most apps only reach for `on-cleanup`.

## Patterns

For component-local state, declare a signal with `save` inside a [view](components.md). For shared state across components, declare signals with `host` at the top of a module and import them. A signal made with `host` lives as long as the program. A field-style store is a record of signals plus tasks that write them, read from any component. See [forms](forms.md) for form-local state and [fetch](fetch.md) for async data.

A write runs every subscriber even when the value did not change. There is no equality check yet. On the server a page renders once, so effects run once and no later write reaches the HTML that was sent.
