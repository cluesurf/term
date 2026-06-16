# GraphQL (`seed graph`)

Define GraphQL types, queries, mutations, and subscriptions. Use
`seed graph` for type definitions. Resolvers use `seed graph-query`,
`seed graph-mutation`, and `seed graph-subscription`.

## Type Definition

Define a GraphQL object type with `seed graph`. Fields use `link`
with types. Mark primary keys with `mark id`.

```tree
seed graph, name user
  link id, like text
    mark id
  link name, like text
  link email, like text
  link role, like text
  link created-at, like text
```

## Enum Type

```tree
seed graph, name role
  seed kind, text <enum>
  case admin
  case member
  case guest
```

## Input Type

Define an input type for mutations.

```tree
seed graph, name create-user-input
  seed kind, text <input>
  link name, like text
  link email, like text
  link role, like text
    need false
    base text <member>
```

## Query Resolver

Resolve a query with `seed graph-query`. The `take` blocks define
query arguments. The resolver body fetches and returns data.

### Single Record

```tree
seed graph-query, name user
  take id, like text

  save user
    call find-user
      bind id, read id

  fork test
    hook test
      call is-none, read user
    hook hold
      halt kink
        make kink
          bind code, text <NOT_FOUND>
          bind text, text <user not found>

  send back, read user
```

### List with Pagination

```tree
seed graph-query, name users
  take page, like u32
    need false
    base mark 1
  take size, like u32
    need false
    base mark 20
  take filter, like text
    need false

  save result
    call list-users
      bind page, read page
      bind size, read size
      bind filter, read filter

  send back
    make user-connection
      bind items, read result/items
      bind total, read result/total
      bind page, read result/page
      bind has-next, read result/has-next
```

### Connection Type for Pagination

```tree
seed graph, name user-connection
  link items, like list
    like user
  link total, like u32
  link page, like u32
  link has-next, like wave
```

## Mutation Resolver

Modify data with `seed graph-mutation`. Return the created or
updated record.

### Create

```tree
seed graph-mutation, name create-user
  take input, like create-user-input

  save existing
    call find-user-by-email
      bind email, read input/email

  fork test
    hook test
      call is-some, read existing
    hook hold
      halt kink
        make kink
          bind code, text <CONFLICT>
          bind text, text <email already exists>

  save user
    call make-user
      bind name, read input/name
      bind email, read input/email
      bind role, read input/role

  send back, read user
```

### Update

```tree
seed graph, name update-user-input
  seed kind, text <input>
  link name, like text
    need false
  link email, like text
    need false
  link role, like text
    need false

seed graph-mutation, name update-user
  take id, like text
  take input, like update-user-input

  save user
    call find-user
      bind id, read id

  fork test
    hook test
      call is-none, read user
    hook hold
      halt kink
        make kink
          bind code, text <NOT_FOUND>
          bind text, text <user not found>

  save updated
    call save-user
      bind id, read id
      bind name, read input/name
      bind email, read input/email
      bind role, read input/role

  send back, read updated
```

### Delete

```tree
seed graph-mutation, name delete-user
  take id, like text

  save user
    call find-user
      bind id, read id

  fork test
    hook test
      call is-none, read user
    hook hold
      halt kink
        make kink
          bind code, text <NOT_FOUND>
          bind text, text <user not found>

  call toss-user
    bind id, read id

  send back, wave true
```

## Nested Types

Define relationships between types. Use resolver fields to load
related data.

```tree
seed graph, name post
  link id, like text
    mark id
  link title, like text
  link body, like text
  link author-id, like text
  link created-at, like text

seed graph, name comment
  link id, like text
    mark id
  link text, like text
  link post-id, like text
  link author-id, like text
  link created-at, like text
```

### Field Resolver

Resolve nested fields that require separate data loading.

```tree
seed graph, name post
  link id, like text
    mark id
  link title, like text
  link body, like text
  link author, like user
    seed resolve
      call find-user
        bind id, read author-id
  link comments, like list
    like comment
    seed resolve
      take first, like u32
        need false
        base mark 10
      call find-comments-by-post
        bind post-id, read id
        bind limit, read first
```

### Query with Nested Data

```tree
seed graph-query, name post
  take id, like text

  save post
    call find-post
      bind id, read id

  fork test
    hook test
      call is-none, read post
    hook hold
      halt kink
        make kink
          bind code, text <NOT_FOUND>
          bind text, text <post not found>

  send back, read post

seed graph-query, name posts
  take page, like u32
    need false
    base mark 1
  take size, like u32
    need false
    base mark 20
  take author-id, like text
    need false

  save result
    call list-posts
      bind page, read page
      bind size, read size
      bind author-id, read author-id

  send back
    make post-connection
      bind items, read result/items
      bind total, read result/total
      bind has-next, read result/has-next
```

## Subscriptions

Real-time data with GraphQL subscriptions. Use `seed graph-subscription`
to define subscription resolvers.

```tree
seed graph-subscription, name message-added
  take channel-id, like text

  call subscribe
    bind topic
      call concat
        bind a, text <messages:>
        bind b, read channel-id

  hook message
    take event, like hash
    send back
      make message
        bind id, read event/id
        bind text, read event/text
        bind from, read event/from
        bind time, read event/time
```

Trigger a subscription from a mutation:

```tree
seed graph-mutation, name send-message
  take channel-id, like text
  take text, like text

  save message
    call make-message
      bind channel-id, read channel-id
      bind text, read text
      bind from, read context/user-id

  call publish
    bind topic
      call concat
        bind a, text <messages:>
        bind b, read channel-id
    bind data, read message

  send back, read message
```

## Authentication Context

Access the authenticated user in resolvers via `read context`.

```tree
seed graph-query, name me
  fork test
    hook test
      call is-none, read context/user
    hook hold
      halt kink
        make kink
          bind code, text <UNAUTHENTICATED>
          bind text, text <not logged in>

  send back, read context/user

seed graph-mutation, name update-profile
  take input, like update-user-input

  fork test
    hook test
      call is-none, read context/user
    hook hold
      halt kink
        make kink
          bind code, text <UNAUTHENTICATED>
          bind text, text <not logged in>

  save updated
    call save-user
      bind id, read context/user/id
      bind name, read input/name
      bind email, read input/email

  send back, read updated
```

## Directives

Apply directives to fields for authorization and caching.

```tree
seed graph, name admin-stats
  link total-users, like u32
    seed directive, text <@auth(requires: ADMIN)>
  link total-revenue, like u32
    seed directive, text <@auth(requires: ADMIN)>
  link total-orders, like u32
    seed directive, text <@auth(requires: ADMIN)>
    seed cache, mark 300
```

## Full Example

A complete GraphQL schema with types, queries, mutations, nested
resolvers, and subscriptions.

```tree
seed graph, name user
  link id, like text
    mark id
  link name, like text
  link email, like text
  link role, like text
  link posts, like list
    like post
    seed resolve
      call find-posts-by-author
        bind author-id, read id

seed graph, name post
  link id, like text
    mark id
  link title, like text
  link body, like text
  link author, like user
    seed resolve
      call find-user
        bind id, read author-id
  link comments, like list
    like comment
    seed resolve
      call find-comments-by-post
        bind post-id, read id

seed graph, name comment
  link id, like text
    mark id
  link text, like text
  link author, like user
    seed resolve
      call find-user
        bind id, read author-id
  link post-id, like text

seed graph, name role
  seed kind, text <enum>
  case admin
  case member
  case guest

seed graph, name create-post-input
  seed kind, text <input>
  link title, like text
  link body, like text

seed graph-query, name user
  take id, like text
  save user
    call find-user
      bind id, read id
  fork test
    hook test
      call is-none, read user
    hook hold
      halt kink
        make kink
          bind code, text <NOT_FOUND>
          bind text, text <user not found>
  send back, read user

seed graph-query, name posts
  take page, like u32
    base mark 1
  take size, like u32
    base mark 20
  save result
    call list-posts
      bind page, read page
      bind size, read size
  send back, read result

seed graph-mutation, name create-post
  take input, like create-post-input
  fork test
    hook test
      call is-none, read context/user
    hook hold
      halt kink
        make kink
          bind code, text <UNAUTHENTICATED>
          bind text, text <must be logged in>
  save post
    call make-post
      bind title, read input/title
      bind body, read input/body
      bind author-id, read context/user/id
  call publish
    bind topic, text <posts:new>
    bind data, read post
  send back, read post

seed graph-subscription, name post-created
  call subscribe
    bind topic, text <posts:new>
  hook message
    take event, like hash
    send back, read event
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Object type | `seed graph, name x` | `seed graph, name user` |
| Field | `link name, like type` | `link email, like text` |
| ID field | `mark id` | `link id, like text` + `mark id` |
| Enum type | `seed kind, text <enum>` | `case admin`, `case member` |
| Input type | `seed kind, text <input>` | mutation input shapes |
| Required field | `need true` (default) | field is non-nullable |
| Optional field | `need false` | field is nullable |
| Default value | `base` | `base text <member>` |
| Query resolver | `seed graph-query, name x` | `seed graph-query, name user` |
| Mutation resolver | `seed graph-mutation, name x` | `seed graph-mutation, name create-user` |
| Subscription | `seed graph-subscription` | `seed graph-subscription, name x` |
| Field resolver | `seed resolve` on `link` | nested data loading |
| Auth context | `read context/user` | access current user |
| Publish event | `call publish` | `bind topic, text <x>` |
| Subscribe | `call subscribe` | `bind topic, text <x>` |
| Message hook | `hook message` | subscription event handler |
| Directive | `seed directive` | `text <@auth(requires: ADMIN)>` |
| Cache field | `seed cache` | `seed cache, mark 300` |
| Error | `halt kink` + `make kink` | `bind code, text <NOT_FOUND>` |
