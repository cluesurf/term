# Events (`seed event`)

Event sourcing in Seed models state as a sequence of immutable events.
Define events with `seed event`, project state with `seed project`, and
build aggregates that enforce business rules. Events are the source of
truth. Current state is derived by replaying them.

## Event Definition

Define domain events with `seed event`.

```tree
seed event
  name <order>

  case order-placed
    link order-id, like uuid
    link customer-id, like uuid
    link items, like list
      like order-item
    link total, like i64

  case order-shipped
    link order-id, like uuid
    link tracking-number, like text
    link carrier, like text

  case order-delivered
    link order-id, like uuid
    link delivered-at, like timestamp

  case order-cancelled
    link order-id, like uuid
    link reason, like text
```

**`seed event`** groups related events under a name.
Each **`case`** is a distinct event type.
**`link`** fields carry the event payload.

## Projection

Build read models from events with `seed project`.

```tree
seed project
  name <order-status>
  bind source, <order>

  hook apply
    take state, like order-state
    take event, like order-event

    fork case, read event/form
      case order-placed
        send back
          make order-state
            bind id, read event/order-id
            bind status, <placed>
            bind total, read event/total
            bind shipped-at, wave false
            bind delivered-at, wave false

      case order-shipped
        send back
          make order-state
            bind id, read state/id
            bind status, <shipped>
            bind total, read state/total
            bind shipped-at, call get-time
            bind delivered-at, wave false

      case order-delivered
        send back
          make order-state
            bind id, read state/id
            bind status, <delivered>
            bind total, read state/total
            bind shipped-at, read state/shipped-at
            bind delivered-at, read event/delivered-at

      case order-cancelled
        send back
          make order-state
            bind id, read state/id
            bind status, <cancelled>
            bind total, read state/total
            bind shipped-at, read state/shipped-at
            bind delivered-at, read state/delivered-at
```

**`seed project`** defines a projection.
**`bind source`** connects it to an event group.
**`hook apply`** takes the current state and an event, returns new state.
Each **`case`** handles one event type.

## Initial State

Define the starting state for a projection.

```tree
form order-state
  link id, like uuid
  link status, like text
  link total, like i64
  link shipped-at, like timestamp
    need false
  link delivered-at, like timestamp
    need false

seed project
  name <order-status>
  bind source, <order>

  hook init
    send back
      make order-state
        bind id, <none>
        bind status, <empty>
        bind total, mark 0
        bind shipped-at, wave false
        bind delivered-at, wave false

  hook apply
    take state, like order-state
    take event, like order-event
    fork case, read event/form
      case order-placed
        send back
          make order-state
            bind id, read event/order-id
            bind status, <placed>
            bind total, read event/total
            bind shipped-at, wave false
            bind delivered-at, wave false
```

**`hook init`** provides the zero state before any events.

## Aggregate

Aggregates enforce rules before accepting events.

```tree
seed aggregate
  name <order>
  bind source, <order>

  hook command
    take name, like text
    take state, like order-state
    take data, like map

    fork case, read name
      case place-order
        fork test
          hook test, call is-equal
            bind a, read state/status
            bind b, <empty>
          hook hold
            send back
              make order-placed
                bind order-id, call make-uuid
                bind customer-id, read data/customer-id
                bind items, read data/items
                bind total, read data/total
          hook miss
            halt kink, <order already exists>

      case ship-order
        fork test
          hook test, call is-equal
            bind a, read state/status
            bind b, <placed>
          hook hold
            send back
              make order-shipped
                bind order-id, read state/id
                bind tracking-number, read data/tracking
                bind carrier, read data/carrier
          hook miss
            halt kink, <order cannot be shipped>

      case cancel-order
        fork test
          hook test, call is-equal
            bind a, read state/status
            bind b, <delivered>
          hook hold
            halt kink, <delivered orders cannot be cancelled>
          hook miss
            send back
              make order-cancelled
                bind order-id, read state/id
                bind reason, read data/reason
```

**`seed aggregate`** wraps command handling with validation.
**`hook command`** receives a command name, current state, and input data.
It returns an event on success or **`halt kink`** on invalid transitions.

## Event Replay

Rebuild state by replaying events.

```tree
task rebuild-order
  take order-id, like uuid

  save events, call load-events
    bind source, <order>
    bind id, read order-id

  save state, call replay-events
    bind project, <order-status>
    bind events, read events

  send back, read state
```

**`call load-events`** fetches all events for an entity.
**`call replay-events`** folds them through the projection to get
current state.

## Snapshots

Optimize replay with periodic snapshots.

```tree
seed snapshot
  name <order-status>
  bind project, <order-status>
  bind every, mark 100

task get-order-fast
  take order-id, like uuid

  save snapshot, call load-snapshot
    bind project, <order-status>
    bind id, read order-id

  save new-events, call load-events
    bind source, <order>
    bind id, read order-id
    bind after, read snapshot/version

  save state, call replay-events
    bind project, <order-status>
    bind events, read new-events
    bind initial, read snapshot/state

  send back, read state
```

**`seed snapshot`** configures automatic snapshots.
**`bind every`** sets how many events between snapshots.
**`call load-snapshot`** fetches the latest snapshot.
Replay only processes events after the snapshot version.

## Event Handlers

React to events with side effects.

```tree
seed handler
  name <order-notifications>
  bind source, <order>

  hook on
    take event, like order-event

    fork case, read event/form
      case order-shipped
        call send-email
          bind to, read event/customer-email
          bind subject, <Your order has shipped>
          bind body, call format-shipping-email
            bind tracking, read event/tracking-number
            bind carrier, read event/carrier

      case order-delivered
        call send-email
          bind to, read event/customer-email
          bind subject, <Your order has been delivered>
```

**`seed handler`** reacts to events asynchronously.
Handlers are for side effects like notifications, not state changes.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed event` | Define an event group |
| `case` | Individual event type within a group |
| `link` | Event payload field |
| `seed project` | Define a state projection |
| `hook apply` | Event application function |
| `hook init` | Initial state factory |
| `take state` | Current state parameter |
| `take event` | Incoming event parameter |
| `seed aggregate` | Define command handler with rules |
| `hook command` | Command processing function |
| `seed snapshot` | Configure snapshot strategy |
| `bind every` | Snapshot frequency (event count) |
| `seed handler` | Define async event handler |
| `hook on` | Event reaction function |
| `call load-events` | Fetch events for an entity |
| `call replay-events` | Fold events through projection |
| `call load-snapshot` | Fetch latest snapshot |
| `bind source` | Event group to connect to |
