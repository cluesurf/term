# Zones

A `zone` is a UI component. It uses fine-grained reactivity: signals plus direct DOM nodes, no virtual DOM. Reading a signal inside a text node or attribute subscribes that spot, and writing the signal patches only that spot. There is no re-render of the whole component.

Every zone is lowered to a plain function over a small render runtime, so all backends emit components with no zone-specific code.

Maps to: a SolidJS component (the same signals plus real-DOM model), but written in the uniform `.tree` shape.

## Cheatsheet

| `.tree` | Job | Lowers to |
| --- | --- | --- |
| `zone <name>` | Declare a component | a function named `<name>` |
| `take host, like view` | The node to mount into (always first param) | the host param |
| `take <prop>` | An input prop callers fill with `bind` | a param |
| `zone <tag>` | A child element (`div`, `span`, ...) | `element("tag")` |
| `zone <component>` | A component call | `component(host, ...props, children)` |
| `text <...>` | A static text node | `text("...")` |
| `read <expr>` | A reactive text node | `dynamic(() => expr)` |
| `bind <name>, <value>` | An attribute (on an element) or a prop (on a component) | `attribute(node, name, value)` |
| `hook <event>, call <fn>` | An event handler | `event(node, "event", () => fn())` |
| `name <ref>` | Bind the element to a local | a `view` local you can `read` |
| `site` | The outlet where a caller's children render | append children thunk |
| `fork` (with `hook test` / `hook hold` / `hook miss`) | Reactive conditional | `show(parent, cond, then, else)` |
| `walk list, read <xs>` | Reactive list | `each(parent, () => xs, item => view)` |
| `save x / call make-signal` | Local reactive state | `const x = makeSignal(init)` |

## Imports

Bring in only the render primitives the component uses.

```tree
load @cluesurf/site/code/zone/render
  find element
  find text
  find dynamic
  find show
  find each
  find append
  find event
load @cluesurf/site/code/zone/reactive
  find make-signal
  find read-signal
  find write-signal
load @cluesurf/site/code/dom/dom
  find view
```

## Defining a component

The first param is always `host`, the node the component mounts into. Other `take` lines are props.

```tree
zone greeting
  take host, like view
  take name
  zone p
    text <Hello>
```

## Elements and nesting

A nested `zone <tag>` is a child element.

```tree
zone card
  take host, like view
  zone div
    zone h1
      text <Title>
    zone p
      text <Body text>
```

## Attributes and props with `bind`

`bind <name>, <value>` binds a value to a name. On an HTML element it is an attribute. On a component it is a prop. The keyword is routed by what the name resolves to. The value is any expression: a literal, a prop read, a signal read.

```tree
zone a
  take host, like view
  take theme
  bind href, text </login>
  bind class, read theme
  text <Sign in>
```

Classes, `href`, `type`, `data-*`, and `aria-*` all pass through verbatim.

## Events with `hook`

```tree
zone button
  take host, like view
  take submit
  hook click, call submit
  text <Send>
```

`hook <event>, call <handler>` binds an event handler. This is the same `hook` keyword used by `fork` and `walk` for branches.

## Static and reactive text

```tree
zone label
  take host, like view
  take count
  text <count: >
  read
    call read-signal
      bind self, read count
```

`text <...>` is a static node. `read <expr>` is a reactive text node: it re-reads its expression and patches in place when a signal it reads changes. See [state](state.md) for signals.

## Element refs with `name`

`name <ref>` binds the built element to a local any handler in the zone can read. Use it to pull a value out of an input.

```tree
zone search
  take host, like view
  take run
  zone input
    name field
  zone button
    hook click, call run
    text <Go>
```

## Local state

`save x / call make-signal / bind value, <init>` declares reactive state.

```tree
zone counter
  take host, like view
  save count
    call make-signal
      bind value, code 0
  zone button
    hook click, call bump
    read
      call read-signal
        bind self, read count
```

Read with `read-signal`, write with `write-signal`. The [state](state.md) page covers the full signal API.

## Conditionals

`fork` renders one branch reactively. `hook test` is the condition, `hook hold` the then branch, `hook miss` the else.

```tree
zone status
  take host, like view
  take ready
  fork
    hook test
      read ready
    hook hold
      zone p
        text <ready>
    hook miss
      zone p
        text <loading...>
```

## Lists

`walk list, read <iterable>` with `hook next` and `take site, name <item>` renders one node per item, reconciled reactively.

```tree
zone menu
  take host, like view
  take items
  zone ul
    walk list, read items
      hook next
        take site, name row
        zone li
          read
            read row/name
```

## Slots

`site` marks where a caller's children render. A component with a site automatically takes a trailing children thunk.

```tree
zone card
  take host, like view
  take class
  zone div
    bind data-slot, text <card>
    bind class, read class
    site
```

## Composition

A `zone <name>` whose name is another component is a component call, not an element. Props pass with `bind`. The nested content becomes the site children.

```tree
zone page
  take host, like view
  zone card
    bind class, text <p-4>
    zone h1
      text <Hello>
```

`card` mounts itself into its host, fills `class` by name, and renders the passed `h1` at its `site`. This is the headless-component foundation.

## Mounting

A top-level component takes `host` (a `view`) and appends its tree to it. Mount it by calling it with the document body, typically from the page entry. Component-to-component nesting needs no separate mount call.

## Why this is clean

Zones lower to ordinary functions in one compiler pass, after type-checking and before emit. The lowering produces generic IR over the render runtime (`element`, `text`, `dynamic`, `show`, `each`, `append`, `event`), so every backend emits components with no zone-specific code. The composition logic lives once, in the lowering, not per backend.
