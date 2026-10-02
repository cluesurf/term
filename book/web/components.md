# Views

A `view` is a UI component. It uses fine-grained reactivity: signals plus direct DOM nodes, no virtual DOM. Reading a signal inside a text node or attribute subscribes that spot, and writing the signal patches only that spot. There is no re-render of the whole component.

Every view is lowered to a plain function over a small render runtime, `@term/site/code/view/render`, so all backends emit components with no view-specific code. A component was spelled `zone` until 2026-08-30. That head now belongs to the secret system, and `@cluesurf/site/code/zone/...` no longer exists.

Maps to: a SolidJS component (the same signals plus real-DOM model), but written in the uniform `.tree` shape.

## Cheatsheet

| `.tree` | Job | Lowers to |
| --- | --- | --- |
| `view <name>` (top level) | Declare a component | a function named `<name>` |
| `take host, like view` | The node to mount into (always first param) | the host param |
| `take <prop>, like <type>` | An input prop callers fill with `bind` | a param |
| `view <tag>` | A child element (`div`, `span`, ...) | `element("tag")` |
| `view <component>` | A component call | `component(host, ...props, children)` |
| `node <tag>` | An element even when a component shares its name | `element("tag")` |
| `text <...>` | A static text node | `text("...")` |
| `read <expr>` | A reactive text node | `dynamic(() => expr)` |
| `seed <attribute>, <value>` | An attribute on an element | `attribute(node, name, value)` |
| `bind <prop>, <value>` | A prop on a component | a named argument |
| `hook <event>, call <fn>` | An event handler | `event(node, "event", () => fn())` |
| `seed <event>` with a body | An event handler written inline | `event(node, "event", () => body)` |
| `name <ref>` | Bind the element to a local | a `view` local you can `read` |
| `site` | The outlet where a caller's children render | append children thunk |
| `fork test` (with `hook test` / `hook hold` / `hook miss`) | Reactive conditional | `show(parent, cond, then, else)` |
| `walk list, read <xs>` | Reactive list | `each(parent, () => xs, item => view)` |
| `save x` over `call make-signal` | Local reactive state | `const x = makeSignal(init)` |

## Imports

A component file loads the `view` handle type. The render primitives are what the lowering calls, so a component never loads them itself. Load the signal tasks from `@term/site/code/view/reactive` when the component holds state.

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find signal
  find make-signal
  find read-signal
  find write-signal
```

## Defining a component

The first param is always `host`, the node the component mounts into. Other `take` lines are props.

```tree
load @term/site/code/dom/dom
  find view

view greeting
  take host, like view
  take name, like text
  view p
    text <Hello, >
    read name
```

## Elements and nesting

A nested `view <tag>` is a child element.

```tree
load @term/site/code/dom/dom
  find view

view card
  take host, like view
  view div
    view h1
      text <Title>
    view p
      text <Body text>
```

## Attributes with `seed`, props with `bind`

`seed <name>, <value>` sets an attribute on an HTML element. `bind <name>, <value>` passes a prop to a component. The value is any expression: a literal, a prop read, a signal read. An attribute whose value reads a prop or a signal is bound reactively.

```tree
load @term/site/code/dom/dom
  find view

view sign-in-link
  take host, like view
  take theme, like text
  view a
    seed href, text </login>
    seed class, read theme
    text <Sign in>
```

Classes, `href`, `type`, `data-*`, and `aria-*` all pass through verbatim.

## Events with `hook`

```tree
load @term/site/code/dom/dom
  find view

view send-button
  take host, like view
  take submit
    like task
  view button
    hook click, call submit
    text <Send>
```

`hook <event>, call <handler>` binds an event handler. This is the same `hook` keyword used by `fork` and `walk` for branches. For a handler of more than one call, write `seed click` with the body beneath it, as in [local state](#local-state).

## Static and reactive text

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find signal
  find read-signal

view count-label
  take host, like view
  take count, like signal number
  view span
    text <count: >
    read
      call read-signal
        bind self, read count
```

`text <...>` is a static node. `read <expr>` is a reactive text node: it re-reads its expression and patches in place when a signal it reads changes. See [state](state.md) for signals.

## Element refs with `name`

`name <ref>` binds the built element to a local any handler in the view can read. Use it to pull a value out of an input with `get-value`.

```tree
load @term/site/code/dom/dom
  find view
  find get-value

view search
  take host, like view
  take run
    like task
      take query, like text
  view input
    name field
  view button
    seed click
      call run
        call get-value, read field
    text <Go>
```

## Local state

`save x` over `call make-signal` declares reactive state.

```tree
load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

view counter
  take host, like view
  save count
    call make-signal
      bind value, code 0
  view button
    seed click
      call write-signal
        bind self, read count
        bind value
          call add
            call read-signal, read count
            code 1
    read
      call read-signal
        bind self, read count
```

Read with `read-signal`, write with `write-signal`. The [state](state.md) page covers the full signal API.

## Conditionals

`fork test` renders one branch reactively. `hook test` is the condition, `hook hold` the then branch, `hook miss` the else.

```tree
load @term/site/code/dom/dom
  find view

view status
  take host, like view
  take ready, like boolean
  fork test
    hook test
      read ready
    hook hold
      view p
        text <ready>
    hook miss
      view p
        text <loading...>
```

## Lists

`walk list, read <iterable>` with `hook next` and `take site, name <item>` renders one node per item. When the list changes, every row is built again. The runtime's keyed `each-keyed` has no markup that reaches it yet.

```tree
load @term/site/code/dom/dom
  find view

load @term/base/code/list
  find list

form item
  link name, like text

view menu
  take host, like view
  take items, like list
  view ul
    walk list, read items
      hook next
        take site, name row
        view li
          read row/name
```

## Slots

`site` marks where a caller's children render. A component with a site automatically takes a trailing children thunk.

```tree
load @term/site/code/dom/dom
  find view

view card
  take host, like view
  take class, like text
  view div
    seed data-slot, text <card>
    seed class, read class
    site
```

## Composition

A `view <name>` whose name is another component is a component call, not an element. Props pass with `bind`. The nested content becomes the site children.

```tree
load @term/site/code/dom/dom
  find view

view card
  take host, like view
  take class, like text
  view div
    seed class, read class
    site

view page
  take host, like view
  view card
    bind class, text <p-4>
    view h1
      text <Hello>
```

`card` mounts itself into its host, fills `class` by name, and renders the passed `h1` at its `site`. This is the headless-component foundation.

## Mounting

A top-level component takes `host` (a `view`) and appends its tree to it. Mount it by calling it with the document body, which is what the framework's `host` does for the page a route picks. Component-to-component nesting needs no separate mount call.

## Why this is clean

Views lower to ordinary functions in one compiler pass, after type-checking and before emit. The lowering produces generic IR over the render runtime (`element`, `text`, `dynamic`, `show`, `each`, `append`, `event`), so every backend emits components with no view-specific code. The composition logic lives once, in the lowering, not per backend.
