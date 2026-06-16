# Meta (`seed meta`)

Declare page metadata, OpenGraph tags, Twitter cards, and structured
data. Use `seed meta` at the page level to control how search engines
and social platforms render your content.

## Basic Meta

```tree
seed meta
  link title, text <My App>
  link description, text <A fast and simple application>
  link charset, text <utf-8>
  link viewport, text <width=device-width, initial-scale=1>
```

## OpenGraph Tags

Control how your page appears when shared on Facebook, LinkedIn, and
other platforms that support OpenGraph.

```tree
seed meta
  link title, text <My App>
  link description, text <Build better products faster>
  link og-title, text <My App - Build Better Products>
  link og-description, text <Build better products faster with our platform>
  link og-image, text <https://example.com/og-image.png>
  link og-url, text <https://example.com>
  link og-type, text <website>
  link og-site-name, text <My App>
```

Article-specific OpenGraph:

```tree
seed meta
  link title, read post/title
  link description, read post/excerpt
  link og-title, read post/title
  link og-description, read post/excerpt
  link og-image, read post/cover-image
  link og-type, text <article>
  link og-article-author, read post/author/name
  link og-article-published, read post/published-at
  link og-article-section, read post/category
```

## Twitter Cards

Configure how your page appears in Twitter/X post previews.

### Summary Card

```tree
seed meta
  link title, text <My App>
  link description, text <Build better products>
  link twitter-card, text <summary>
  link twitter-site, text <@myapp>
  link twitter-title, text <My App>
  link twitter-description, text <Build better products>
  link twitter-image, text <https://example.com/card.png>
```

### Large Image Card

```tree
seed meta
  link title, read post/title
  link description, read post/excerpt
  link twitter-card, text <summary_large_image>
  link twitter-site, text <@myapp>
  link twitter-creator, read post/author/twitter
  link twitter-title, read post/title
  link twitter-description, read post/excerpt
  link twitter-image, read post/cover-image
  link twitter-image-alt, read post/cover-alt
```

## Canonical URL

Prevent duplicate content issues with a canonical link.

```tree
seed meta
  link title, text <Product Page>
  link canonical, text <https://example.com/products/widget>
```

Dynamic canonical:

```tree
seed meta
  link title, read product/name
  link canonical
    call concat
      bind a, text <https://example.com/products/>
      bind b, read product/slug
```

## Favicon and Icons

```tree
seed meta
  link icon, text </favicon.ico>
  link icon-svg, text </icon.svg>
  link apple-touch-icon, text </apple-touch-icon.png>
  link manifest, text </site.webmanifest>
  link theme-color, text <#4CAF50>
```

## Robots and Indexing

Control search engine crawling.

```tree
seed meta
  link robots, text <index, follow>
  link googlebot, text <index, follow, max-snippet:-1>
```

Block indexing for private pages:

```tree
seed meta
  link robots, text <noindex, nofollow>
```

## Dynamic Meta from Data

Build meta tags from fetched data. Useful for detail pages where
the title and description come from the database.

```tree
zone product-page
  take product-id, like text

  seed fetch, name product
    seed url
      call concat
        bind a, text </api/products/>
        bind b, read product-id

  fork case, read product/state
    case done
      seed meta
        link title
          call concat
            bind a, read product/data/name
            bind b, text < - My Store>
        link description, read product/data/description
        link og-title, read product/data/name
        link og-description, read product/data/description
        link og-image, read product/data/image
        link og-type, text <product>
        link twitter-card, text <summary_large_image>
        link twitter-title, read product/data/name
        link twitter-image, read product/data/image
        link canonical
          call concat
            bind a, text <https://store.com/products/>
            bind b, read product/data/slug

      zone div
        zone h1
          read product/data/name
        zone p
          read product/data/description
```

## Structured Data (JSON-LD)

Add structured data for rich search results.

### Organization

```tree
seed meta
  link title, text <My Company>
  link structured-data
    make json-ld
      bind type, text <Organization>
      bind name, text <My Company>
      bind url, text <https://example.com>
      bind logo, text <https://example.com/logo.png>
      bind same-as
        list text
          text <https://twitter.com/mycompany>
          text <https://linkedin.com/company/mycompany>
```

### Product

```tree
seed meta
  link title, read product/name
  link structured-data
    make json-ld
      bind type, text <Product>
      bind name, read product/name
      bind description, read product/description
      bind image, read product/image
      bind brand
        make json-ld
          bind type, text <Brand>
          bind name, read product/brand
      bind offers
        make json-ld
          bind type, text <Offer>
          bind price, read product/price
          bind currency, text <USD>
          bind availability, text <https://schema.org/InStock>
```

### Article

```tree
seed meta
  link title, read post/title
  link structured-data
    make json-ld
      bind type, text <Article>
      bind headline, read post/title
      bind description, read post/excerpt
      bind image, read post/cover-image
      bind date-published, read post/published-at
      bind date-modified, read post/updated-at
      bind author
        make json-ld
          bind type, text <Person>
          bind name, read post/author/name
      bind publisher
        make json-ld
          bind type, text <Organization>
          bind name, text <My Blog>
          bind logo
            make json-ld
              bind type, text <ImageObject>
              bind url, text <https://blog.com/logo.png>
```

### Breadcrumbs

```tree
seed meta
  link structured-data
    make json-ld
      bind type, text <BreadcrumbList>
      bind items
        list json-ld
          make json-ld
            bind type, text <ListItem>
            bind position, mark 1
            bind name, text <Home>
            bind url, text <https://example.com>
          make json-ld
            bind type, text <ListItem>
            bind position, mark 2
            bind name, text <Products>
            bind url, text <https://example.com/products>
          make json-ld
            bind type, text <ListItem>
            bind position, mark 3
            bind name, read product/name
```

## Per-Route Meta

Set meta at the route level. Each page defines its own meta block.

```tree
dock /
  seed meta
    link title, text <Home - My App>
    link description, text <Welcome to My App>
    link og-title, text <My App>
    link og-image, text <https://example.com/home-og.png>

dock /about
  seed meta
    link title, text <About - My App>
    link description, text <Learn about our mission>

dock /blog/:slug
  seed meta
    link title, read post/title
    link description, read post/excerpt
    link og-type, text <article>
```

## Full Example

A complete page with meta, OpenGraph, Twitter card, structured data,
and dynamic content.

```tree
zone blog-post
  take slug, like text

  seed fetch, name post
    seed url
      call concat
        bind a, text </api/posts/>
        bind b, read slug
    seed cache, wave true
    seed stale, mark 300000

  fork case, read post/state
    case done
      seed meta
        link title
          call concat
            bind a, read post/data/title
            bind b, text < - My Blog>
        link description, read post/data/excerpt
        link canonical
          call concat
            bind a, text <https://blog.com/>
            bind b, read post/data/slug
        link og-title, read post/data/title
        link og-description, read post/data/excerpt
        link og-image, read post/data/cover-image
        link og-type, text <article>
        link og-article-published, read post/data/published-at
        link og-article-author, read post/data/author/name
        link twitter-card, text <summary_large_image>
        link twitter-site, text <@myblog>
        link twitter-title, read post/data/title
        link twitter-image, read post/data/cover-image
        link robots, text <index, follow>
        link structured-data
          make json-ld
            bind type, text <Article>
            bind headline, read post/data/title
            bind description, read post/data/excerpt
            bind image, read post/data/cover-image
            bind date-published, read post/data/published-at
            bind date-modified, read post/data/updated-at
            bind author
              make json-ld
                bind type, text <Person>
                bind name, read post/data/author/name

      zone article
        zone h1
          read post/data/title
        zone div
          seed class, text <meta>
          zone span
            read post/data/author/name
          zone span
            read post/data/published-at
        zone div
          seed class, text <content>
          read post/data/body

    case load
      seed meta
        link title, text <Loading... - My Blog>
      zone span
        text <Loading...>
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Meta block | `seed meta` | page-level metadata |
| Title | `link title` | `link title, text <My App>` |
| Description | `link description` | `link description, text <...>` |
| Charset | `link charset` | `link charset, text <utf-8>` |
| Viewport | `link viewport` | `link viewport, text <width=...>` |
| OG title | `link og-title` | `link og-title, read post/title` |
| OG description | `link og-description` | OpenGraph description |
| OG image | `link og-image` | `link og-image, text <url>` |
| OG type | `link og-type` | `text <website>`, `text <article>` |
| Twitter card | `link twitter-card` | `text <summary_large_image>` |
| Twitter site | `link twitter-site` | `link twitter-site, text <@x>` |
| Canonical | `link canonical` | `link canonical, text <url>` |
| Favicon | `link icon` | `link icon, text </favicon.ico>` |
| Robots | `link robots` | `link robots, text <index, follow>` |
| Theme color | `link theme-color` | `link theme-color, text <#fff>` |
| Structured data | `link structured-data` | `make json-ld` |
| Dynamic meta | `read` expressions | `link title, read post/title` |
| Per-route meta | `seed meta` inside `dock` | route-specific tags |
