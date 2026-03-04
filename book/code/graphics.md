# Graphics

Define UI components with `zone`. Define animations with `tune`.

## Components (`zone`)

A zone is a declarative UI component:

```tree
zone counter
  take count, like u64

  hook mount-start
    save count, mark 0

  hook click
    save count
      call add
        bind a, read count
        bind b, mark 1

  hook leave
    show text <counter unmounted>
```

## Lifecycle Hooks

| Hook | When |
| --- | --- |
| `mount-start` | Component is added to the screen |
| `leave-start` | Component begins removal |
| `leave` | Component is fully removed |

## Animations (`tune`)

Define transitions and animations:

```tree
tune fade-in
  take duration, like u64
  take target

  hook start
    save target/opacity, comb 0.0

  hook step
    take progress, like f64
    save target/opacity, read progress

  hook done
    save target/opacity, comb 1.0
```

## Event Handlers

Handle user input events:

```tree
zone button
  take label, like text

  hook click
    call on-press

  hook hover-start
    save style/color, text <blue>

  hook hover-leave
    save style/color, text <gray>
```

## Nested Components

Zones can contain other zones:

```tree
zone app
  zone header
    take title, like text
  zone body
    zone counter
      take count, mark 0
```
