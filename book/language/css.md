# Look (CSS)

Term styles are written in the `look` DSL and compiled to a plain CSS stylesheet at build time. There is no runtime: a `.tree` look sheet lowers to a static `.css` file the same way a `zone` lowers to a component. The DSL is a structured tree, so a selector, a value, a media query, and a keyframe are all just nested nodes instead of a flat string you have to parse.

Maps to: a CSS stylesheet (`.css`). Every construct below has one exact CSS shape.

## Cheatsheet

| Write | Means |
| --- | --- |
| `face <name>` | a utility class `.name` |
| `base style` | a style rule (selector tree + declarations) |
| `base font-face` | an `@font-face` block |
| `base media` | an `@media` query wrapping rules |
| `base container` | a `@container` query wrapping rules |
| `base layers` | an `@layer a, b, c;` order declaration |
| `base layer, name <x>` | an `@layer x { ... }` block |
| `base keyframes, name <x>` | a `@keyframes x { ... }` block |
| `tone` / `tone dark` | theme tokens on `:root` / `.dark` |
| `find <tag>` | the root element of a selector |
| `link <tag>` | a combined element (descendant by default) |
| `have <property>, <value>` | one CSS declaration |
| `have <qualifier>, <value>` | a selector qualifier (inside `find` / `link`) |
| `lack <qualifier>, <value>` | a negated qualifier (`:not(...)`) |
| `case <variant>` | a variant block (`face`) or a keyframe stop |

The rule in one breath: **the tree shape is the CSS shape**. Nesting a `link` under a `find` is a combinator, a `have` under a `have` is a function, a `find` under a `have match` is `:has()`, and the property/value split is a declaration.

## Values

A value follows the comma on a `have` line, or hangs as children below it.

- **Bare text** is a keyword, dimension, or number: `have font-size, 17px`, `have font-weight, 400`, `have color, red`. Quote with `<...>` when it holds spaces or characters the tree parser would eat: `have content, <↗>`.
- **A list** is many children, joined by the property's natural separator — commas for list properties (`font-family`, `transition`, `animation`, `grid-template-areas`), spaces otherwise.

  ```tree
  have font-family
    <CrowMark>
    <ui-monospace>
    <SFMono-Regular>
    <monospace>
  ```

  → `font-family: CrowMark, ui-monospace, SFMono-Regular, monospace`

  ```tree
  have grid-template-columns
    1fr
    2fr
  ```

  → `grid-template-columns: 1fr 2fr`

- **A function** is a nested `have` whose head is the function name:

  ```tree
  have src
    have url, </base/text/CrowMark-Regular.otf>
    have format, <opentype>
  ```

  → `src: url("/base/text/CrowMark-Regular.otf") format("opentype")`

- **`tint`** is the color constructor: `tint <space>, ...args` builds a color in that space. Written head-first with no parentheses (parentheses are not `.tree` syntax), so the space is the first argument and the components follow:

  | Write | Means |
  | --- | --- |
  | `tint rgb, 63, 63, 70` | `rgb(63, 63, 70)` |
  | `tint hex, <f5f5f5>` | `#f5f5f5` |
  | `tint oklch, <72%>, 0.18, 250` | `oklch(72% 0.18 250)` |

- **`transform`** takes axis children: `have y, 8px` → `translateY(8px)`, `have x, 8px` → `translateX(8px)`, `have scale, 0.9` → `scale(0.9)`.

  ```tree
  have transform
    have y, 8px
  ```

  → `transform: translateY(8px)`

## `face` — a utility class

`face <name>` is a single utility class, with `have` declarations and optional `case` variant blocks. This is the Tailwind-style atom: components carry class names, and the compiler emits only the classes actually used (a JIT).

```tree
face flex
  have display, flex

face landing-h1
  have font-size, 44px
  have line-height, 1.2
  have font-weight, 700
  have text-transform, uppercase
```

A `case` is a variant on the same class — a responsive breakpoint (`sm`, `tablet`, `desktop`), a state (`hover`, `focus`), or a theme (`dark`):

```tree
face landing-h1
  have font-size, 44px
  case sm
    have font-size, 56px
```

→ `.landing-h1 { font-size: 44px } @media (min-width: 640px) { .landing-h1 { font-size: 56px } }`

## `base style` — a style rule

`base style` is a full CSS rule. Its selector is built from a `find` (the root element) with nested `link` children (combined elements); its declarations are the trailing `have <property>, <value>` lines.

```tree
base style
  find html
  find body
  have font-family
    <CrowMark>
    <ui-monospace>
    <SFMono-Regular>
    <monospace>
  have font-size, 17px
  have font-weight, 500
  have line-height, 1.5
  have color, tint rgb, 63, 63, 70
```

Two `find`s at the same level are a selector list (comma-separated):

→ `html, body { font-family: CrowMark, ...; font-size: 17px; ... }`

### Selector qualifiers

Inside a `find` or `link`, a `have` qualifies that element rather than declaring a property:

| Write | Means |
| --- | --- |
| `have id, <app>` | `#app` |
| `have class, <card>` | `.card` |
| `have <attr>, <value>` | `[attr="value"]` |
| `have <attr>` + nested `have start, <x>` | `[attr^="x"]` (`start`/`end`/`has`/`word` → `^= $= *= ~=`) |
| `have state, <hover>` | `:hover` (2+ states → `:is(:a, :b)`) |
| `have position, <2n + 1>` | `:nth-child(2n + 1)` |
| `have part, <after>` | `::after` (pseudo-element) |
| `have match` + nested selector | `:has(...)` |
| `have constraint` + nested `have class` | `:where(.a, .b)` |
| `lack field, <hidden>` | `:not([hidden])` |
| `lack <attr>, <value>` | `:not([attr="value"])` |
| `any` (as a `find`/`link` tag) | `*` |

### Combinators

`link` combines a new element onto the selector. The `like` child names the combinator; with no `like`, it is a descendant:

| Write | Combinator | Means |
| --- | --- | --- |
| `link <tag>` | (descendant) | `a b` |
| `link <tag>, like child` | `>` | `a > b` |
| `link <tag>, like next` | `+` | `a + b` (adjacent sibling) |
| `link <tag>, like after` | `~` | `a ~ b` (general sibling) |

A worked example:

```tree
base style
  find main
    have id, <app>
    link section, like child
      have class, <dashboard>
      have data-state, <ready>
    link article
      have class, <card>
      have class, <featured>
      lack field, <hidden>
    link header, like child
      have class, <card-header>
    link h2
      have class, <title>
      have state, <hover>
      have state, <focus-visible>
  have color, red
```

→

```css
main#app
  > section.dashboard[data-state="ready"]
  article.card.featured:not([hidden])
  > header.card-header
  h2.title:is(:hover, :focus-visible) {
  color: red;
}
```

The full-power example, exercising every qualifier:

```tree
base style
  find main
    have id, <app>
    have class, <theme-dark>
    link section, like child
      have class, <dashboard>
      have data-state, <ready>
      have match
        find header
          link h1
            have state, hover
            have state, focus-visible
    link article
      have class, <card>
      have class, <featured>
      lack field, hidden
    link article, like next
      have class, <card>
      have data-kind, <summary>
    link aside, like after
      have class, <notice>
      have constraint
        have class, <info>
        have class, <warning>
    link ul, like child
      have class, <items>
    link li, like child
      have position, <2n + 1>
      have match
        find input
          have state, checked
    link a
      have href
        have start, </docs/>
      lack aria-disabled, <true>
      have part, <after>
  have content, <↗>
  have color, red
```

→

```css
main#app.theme-dark
  > section.dashboard[data-state="ready"]:has(> header h1:is(:hover, :focus-visible))
  article.card.featured:not([hidden])
  + article.card[data-kind="summary"]
  ~ aside.notice:where(.info, .warning)
  > ul.items
  > li:nth-child(2n + 1):has(> input:checked)
  a[href^="/docs/"]:not([aria-disabled="true"])::after {
  content: "↗";
  color: red;
}
```

## `base font-face` — `@font-face`

```tree
base font-face
  have font-family, <CrowMark>
  have src
    have url, </base/text/CrowMark-Regular.otf>
    have format, <opentype>
  have font-weight, 400
  have font-style, <normal>
  have font-display, <swap>
```

→

```css
@font-face {
  font-family: CrowMark;
  src: url("/base/text/CrowMark-Regular.otf") format("opentype");
  font-weight: 400;
  font-style: normal;
  font-display: swap;
}
```

## `base media` — `@media`

A media query is its conditions, then the rules it wraps. Each condition is a `have`; `lack` negates (`not`).

| Write | Means |
| --- | --- |
| `have type, <screen>` | `screen` |
| `lack type, <print>` | `not print` |
| `have width` + `have min, 768px` / `have max, 1280px` | `(min-width: 768px) and (max-width: 1280px)` |
| `have <feature>, <value>` | `(feature: value)` (e.g. `have hover, <hover>`) |
| `have preference` + `have color-scheme, <dark>` | `(prefers-color-scheme: dark)` |
| `have all` | `( ... and ... )` |
| `have any` | `( ... or ... )` |

```tree
base media
  have type, <screen>
  have width
    have min, 768px
    have max, 1280px
  have orientation, <landscape>
  have hover, <hover>
  have pointer, <fine>
  have preference
    have color-scheme, <dark>
    have reduced-motion, <no-preference>
  base style
    find main
      have id, <app>
    have content, <↗>
    have color, tint oklch, <72%>, 0.18, 250
```

→

```css
@media screen and (min-width: 768px) and (max-width: 1280px)
  and (orientation: landscape) and (hover: hover) and (pointer: fine)
  and (prefers-color-scheme: dark) and (prefers-reduced-motion: no-preference) {
  main#app {
    content: "↗";
    color: oklch(72% 0.18 250);
  }
}
```

Nested `any` / `all` build boolean groups:

```tree
base media
  have any
    have all
      have hover, <hover>
      have pointer, <fine>
    have all
      have pointer, <coarse>
      have any-hover, <hover>
```

→ `@media ((hover: hover) and (pointer: fine)) or ((pointer: coarse) and (any-hover: hover))`

And `not` with a range:

```tree
base media
  lack type, <print>
  have width
    have min, 900px
```

→ `@media not print and (width >= 900px)`

## `base container` — `@container`

A container query mirrors `base media`, plus `have style` for style queries. The container is set up on the parent with a `have container` declaration:

```tree
face card-grid
  have container
    have name, <cards>
    have type, <inline-size>

base container
  have name, <cards>
  have width
    have min, 640px
  have style
    bind theme, <dark>
  face card
    have grid-template-columns
      1fr
      2fr
```

→

```css
.card-grid { container-name: cards; container-type: inline-size; }

@container cards (width >= 640px) and (style(--theme: dark)) {
  .card { grid-template-columns: 1fr 2fr; }
}
```

## `base layers` / `base layer` — `@layer`

`base layers` declares the layer order; `base layer, name <x>` opens a layer block:

```tree
base layers
  <reset>
  <base>
  <components>

base layer, name <components>
  face button
    have padding, 1rem
```

→

```css
@layer reset, base, components;

@layer components {
  .button { padding: 1rem; }
}
```

## `base keyframes` — `@keyframes`

Each `case` is a stop (`from`, `to`, or a `<percent>`):

```tree
base keyframes, name <fade-slide>
  case from
    have opacity, 0
    have transform
      have y, 8px
  case <50%>
    have opacity, 0.5
  case to
    have opacity, 1
    have transform
      have y, 0
```

→

```css
@keyframes fade-slide {
  from { opacity: 0; transform: translateY(8px); }
  50% { opacity: 0.5; }
  to { opacity: 1; transform: translateY(0); }
}
```

## `tone` — theme tokens

`tone base` emits custom properties on `:root`; `tone dark` scopes them to `.dark`. The scope is always named (`base` for the default), so the two blocks read as a matched pair:

```tree
tone base
  have color-ink, tint rgb, 24, 24, 27

tone dark
  have color-ink, tint rgb, 244, 244, 245
```

→ `:root { --color-ink: rgb(24, 24, 27) } .dark { --color-ink: rgb(244, 244, 245) }`

## Implementation

The grammar is a self-hosted mill at `deck/mill/code/look/` (`mine` parses the tree into the look AST, `mint` prints it back). The AST forms live in `@cluesurf/seed/code/look`. A static-output pass lowers that AST to a `.css` string at build time — no runtime, Tailwind-style JIT for `face` classes (only used classes are emitted; `base` / at-rule blocks always emit).
