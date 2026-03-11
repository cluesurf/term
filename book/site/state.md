# State Management

Declare reactive client-side state with `seed store`. Each store holds
typed fields, default values, and mutation tasks. Components read store
fields reactively and re-render on change.

## Defining a Store

Use `seed store, name <name>` to declare a named store. Fields use
`link` with types and optional `base` defaults.

```tree
seed store, name counter
  link count, like u64
    base mark 0
  link label, like text
    base text <clicks>
```

## Field Types

Fields support all standard types.

```tree
seed store, name settings
  link theme, like text
    base text <light>
  link font-size, like u64
    base mark 16
  link sidebar-open, like boolean
    base wave true
```

## Optional Fields

Use `like maybe` to declare optional state. Construct with `make some`
or `make none`.

```tree
seed store, name app
  link user, like maybe
    like user
  link error, like maybe
    like text
```

Set optional values in tasks:

```tree
task login
  take user, like user
  save self/user, make some
    bind value, read user

task logout
  save self/user, make none
```

Check optional values in components:

```tree
fork test
  hook test
    call is-some, read app/user
  hook hold
    zone span
      read app/user/value/name
  hook miss
    zone span
      text <not logged in>
```

## Actions

Define mutations with `task`. Use `save self/field` to update store
fields and `read self/field` to access them.

```tree
seed store, name counter
  link count, like u64
    base mark 0

  task add
    save self/count
      call add
        bind a, read self/count
        bind b, mark 1

  task reset
    save self/count, mark 0

  task set
    take value, like u64
    save self/count, read value
```

## Reading State in Components

Components read store fields with `read store-name/field`. The
component re-renders when the referenced field changes.

```tree
zone todo-count
  save count
    call count-list
      bind list, read app/todos
  zone span
    lace text
      text <You have >
      read count
      text < todos>
```

Bind store fields directly to element attributes:

```tree
zone settings-panel
  zone div
    seed class, read settings/theme
    zone input
      seed value, read settings/font-size
```

## Computed Values

Derive values from store fields with `save` inside a component. The
computed value updates when its dependencies change.

```tree
zone todo-summary
  save total
    call count-list
      bind list, read app/todos
  save done
    call count-list
      bind list
        call filter
          bind list, read app/todos
          bind test
            task check
              take item, like todo
              send back, read item/done
  save left
    call subtract
      bind a, read total
      bind b, read done

  zone div
    lace text
      read left
      text < of >
      read total
      text < remaining>
```

## List Operations

Work with list-typed state fields using standard list operations.

### Push

```tree
task add-todo
  take title, like text
  save todo
    make todo
      bind id, call gen-id
      bind title, read title
      bind done, wave false
  call push
    bind list, read self/todos
    bind item, read todo
```

### Filter

```tree
task clear-done
  save self/todos
    call filter
      bind list, read self/todos
      bind test
        task check
          take item, like todo
          send back
            call negate
              bind value, read item/done
```

### Map

```tree
task mark-all-done
  save self/todos
    call map
      bind list, read self/todos
      bind task
        task transform
          take item, like todo
          send back
            make todo
              bind id, read item/id
              bind title, read item/title
              bind done, wave true
```

## Nested State Updates

Update nested fields with path syntax on `save`.

```tree
seed store, name profile
  link user, like user
  link address, like address

  task set-name
    take name, like text
    save self/user/name, read name

  task set-city
    take city, like text
    save self/address/city, read city
```

Update items inside a list by iterating:

```tree
task toggle-todo
  take id, like text
  walk list, read self/todos
    hook next
      take site, name todo
      fork test
        hook test
          call is-equal
            bind a, read todo/id
            bind b, read id
        hook hold
          save todo/done
            call negate
              bind value, read todo/done
```

## Multiple Stores

Declare separate stores for different concerns. Components can read
from any store.

```tree
seed store, name auth
  link user, like maybe
    like user
  link token, like maybe
    like text

  task login
    take user, like user
    take token, like text
    save self/user, make some
      bind value, read user
    save self/token, make some
      bind value, read token

  task logout
    save self/user, make none
    save self/token, make none
```

```tree
seed store, name ui
  link sidebar-open, like boolean
    base wave false
  link modal, like maybe
    like text

  task toggle-sidebar
    save self/sidebar-open
      call negate
        bind value, read self/sidebar-open

  task open-modal
    take name, like text
    save self/modal, make some
      bind value, read name

  task close-modal
    save self/modal, make none
```

Read from both in one component:

```tree
zone header
  zone div
    fork test
      hook test
        call is-some, read auth/user
      hook hold
        zone span
          read auth/user/value/name
      hook miss
        zone button
          text <Sign In>
    zone button
      seed click, call ui/toggle-sidebar
      text <Menu>
```

## Store Composition

One store can read from another store in its tasks.

```tree
seed store, name cart
  link items, like list
    like cart-item

  task add
    take product, like product
    fork test
      hook test
        call is-none, read auth/user
      hook hold
        halt kink
          bind text, text <must be logged in>
    call push
      bind list, read self/items
      bind item
        make cart-item
          bind product, read product
          bind count, mark 1
```

## Async Actions

Use `mark async` on calls to handle async operations. Track loading
state and errors explicitly.

```tree
seed store, name posts
  link items, like list
    like post
  link loading, like boolean
    base wave false
  link error, like maybe
    like text

  task load
    save self/loading, wave true
    save self/error, make none
    save result
      call fetch-posts
        mark async
    fork case, read result
      case okay
        save self/items, read result/value
        save self/loading, wave false
      case error
        save self/error, make some
          bind value, read result/text
        save self/loading, wave false

  task create
    take title, like text
    take body, like text
    save result
      call create-post
        mark async
        bind title, read title
        bind body, read body
    fork case, read result
      case okay
        call push
          bind list, read self/items
          bind item, read result/value
      case error
        save self/error, make some
          bind value, read result/text
```

Show loading and error states in components:

```tree
zone post-list
  fork test
    hook test
      read posts/loading
    hook hold
      zone div
        text <Loading...>
    hook miss
      fork test
        hook test
          call is-some, read posts/error
        hook hold
          zone div
            seed class, text <error>
            read posts/error/value
        hook miss
          walk list, read posts/items
            hook next
              take site, name post
              zone div
                zone h2
                  read post/title
                zone p
                  read post/body
```

## Full Example

A complete todo app with state management.

```tree
seed store, name app
  link user, like maybe
    like user
  link todos, like list
    like todo
  link filter, like text
    base text <all>

  task login
    take user, like user
    save self/user, make some
      bind value, read user

  task logout
    save self/user, make none

  task add-todo
    take title, like text
    save todo
      make todo
        bind id, call gen-id
        bind title, read title
        bind done, wave false
    call push
      bind list, read self/todos
      bind item, read todo

  task toggle-todo
    take id, like text
    walk list, read self/todos
      hook next
        take site, name todo
        fork test
          hook test
            call is-equal
              bind a, read todo/id
              bind b, read id
          hook hold
            save todo/done
              call negate
                bind value, read todo/done

  task set-filter
    take filter, like text
    save self/filter, read filter
```

```tree
zone todo-app
  save visible
    fork case, read app/filter
      case all
        read app/todos
      case done
        call filter
          bind list, read app/todos
          bind test
            task check
              take item, like todo
              send back, read item/done
      case left
        call filter
          bind list, read app/todos
          bind test
            task check
              take item, like todo
              send back
                call negate
                  bind value, read item/done

  zone div
    zone input
      seed type, text <text>
      seed key-enter, call app/add-todo
        bind title, read self/value

    zone div
      seed class, text <filters>
      zone button
        seed click, call app/set-filter
          bind filter, text <all>
        text <All>
      zone button
        seed click, call app/set-filter
          bind filter, text <done>
        text <Done>
      zone button
        seed click, call app/set-filter
          bind filter, text <left>
        text <Active>

    walk list, read visible
      hook next
        take site, name todo
        zone div
          zone input
            seed type, text <checkbox>
            seed checked, read todo/done
            seed change, call app/toggle-todo
              bind id, read todo/id
          zone span
            read todo/title
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Declare store | `seed store, name x` | `seed store, name app` |
| State field | `link name, like type` | `link count, like u64` |
| Default value | `base value` | `base mark 0` |
| Optional field | `like maybe` + `like type` | `like maybe` / `like user` |
| Set some | `make some` + `bind value` | `make some` / `bind value, read x` |
| Set none | `make none` | `save self/user, make none` |
| Mutation task | `task name` | `task add-todo` |
| Update field | `save self/field` | `save self/count, mark 0` |
| Read field | `read self/field` | `read self/count` |
| Read in component | `read store/field` | `read app/todos` |
| Call action | `call store/task` | `call app/add-todo` |
| List push | `call push` + `bind list/item` | `call push` / `bind list, read self/items` |
| List filter | `call filter` + `bind list/test` | `call filter` / `bind list, read self/todos` |
| List map | `call map` + `bind list/task` | `call map` / `bind list, read self/todos` |
| Nested update | `save self/a/b` | `save self/user/name, read name` |
| Async call | `mark async` on `call` | `call fetch-posts` / `mark async` |
| Loading state | `link loading, like boolean` | `base wave false` |
| Error state | `like maybe` + `like text` | `save self/error, make some` |
| Computed value | `save x` in component | `save count, call count-list` |
| Event binding | `seed event, call store/task` | `seed click, call app/login` |
