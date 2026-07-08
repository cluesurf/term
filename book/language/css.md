# CSS Examples/DSL

```tree
base font-face
  have font-family, <CrowMark>
  have src
    have url, </base/text/CrowMark-Regular.otf>
    have format, <opentype>
  have font-weight, 400
  have font-style, <normal>
  have font-display, <swap>

base style
  find <html>
  find <body>

  have font-family
    <CrowMark>
    <ui-monospace>
    <SFMono-Regular>
    <monospace>
  have font-size, 17px
  have font-weight, 500
  have line-height, 1.5
  have color, tint(rgb, 63, 63, 70)

base find
  find any # `any` is keyword for * basically
    have state, <selection>

  have background-color, tint(hex, <f5f5f5>)
  have color, tint(rgb, 24, 24, 27)
```

Then for complex selectors, could get fancy, doing chaining
nested-selectors with `link` inside `find`:

```tree
base style
  find main
    have id, <app>
    link section, like child
      have class, <dashboard>
      have data-state, <ready>
    link article # no `like child` means its `a b` selector, instead of `a > b`
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

for css:

```css
main#app
  > section.dashboard[data-state='ready']
  article.card.featured:not([hidden])
  > header.card-header
  h2.title:is(:hover, :focus-visible) {
  color: red;
}
```

And for this even more complex/crazy CSS:

```css
main#app.theme-dark
  > section.dashboard[data-state='ready']:has(
    > header h1:is(:hover, :focus-visible)
  )
  article.card.featured:not([hidden])
  + article.card[data-kind~='summary']
  ~ aside.notice:where(.info, .warning)
  > ul.items
  > li:nth-child(2n + 1):has(> input:checked)
  a[href^='/docs/']:not([aria-disabled='true'])::after {
  content: '↗';
  color: red;
}
```

Perhaps:

```tree
base style
  find main
    have id, <app>
    have class, <theme-dark>

    link section, like child
      have class, <dashboard>
      have data-state, <ready>
      have match # has(...)
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
    link li, like  child
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

And also media queries, from this CSS:

```css
@media screen and (min-width: 768px) and (max-width: 1280px) and (orientation: landscape) and (hover: hover) and (pointer: fine) and (prefers-color-scheme: dark) and (prefers-reduced-motion: no-preference) {
  main#app {
    content: '↗';
    color: oklch(72% 0.18 250);
  }
}
```

to this sort of tree?:

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

  base find
    find main, have id, <app>
    have content, <↗>
    have color, tint(oklch, <72%>, 0.18, 250)
```

Or this:

```css
@media ((hover: hover) and (pointer: fine)) or ((pointer: coarse) and (any-hover: hover));
```

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

Or with `@media` w/ `not`:

```css
@media not print and (width >= 900px);
```

```tree
base media
  lack type, <print>

  have width
    have min, 900px
```

And this:

```css
.card-grid {
  container-name: cards;
  container-type: inline-size;
}

@container cards (width >= 640px) and (style(--theme: dark)) {
  .card {
    grid-template-columns: 1fr 2fr;
  }
}
```

as .tree sort of like:

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

And `@layer`:

```css
@layer reset, base, components;

@layer components {
  .button {
    padding: 1rem;
  }
}
```

```tree
base layers
  <reset>
  <base>
  <components>

base layer, name <components>
  face find
    have padding, 1rem
```

Then keyframes too:

```css
@keyframes fade-slide {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  50% {
    opacity: 0.5;
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

```tree
base keyframes, name <fade-slide>
  case from
    have opacity, 0
    have transform
      have y, 8px

  case <50%>
    have opacity, 0.5

  case <to>
    have opacity, 1
    have transform
      have y, 0
```

And similar things for other CSS sorts of props
