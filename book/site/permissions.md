# Permissions

Authorization controls what authenticated users can do. Authentication
verifies identity. This guide covers role-based access control (RBAC),
policies, and route guards in Seed.

## Defining Roles

Use `seed role` to declare named roles with allowed actions per
resource. Each `case` maps a resource name to a space-separated list of
actions.

```tree
seed role, name guest
  seed allow
    case posts, text <read>
    case comments, text <read>

seed role, name member
  seed allow
    case posts, text <read write>
    case comments, text <read write>

seed role, name admin
  seed allow
    case users, text <read write>
    case posts, text <read write delete>

seed role, name super-admin
  seed allow
    case users, text <read write delete>
    case settings, text <read write>
    case billing, text <read write>
```

## Permission Actions

Actions are plain text labels. Common ones:

| Action | Meaning |
|---|---|
| `read` | View the resource |
| `write` | Create or update the resource |
| `delete` | Remove the resource |

You can define custom actions for your domain. Actions are just strings
that your permission checks match against.

## Role Inheritance

Use `seed inherit` to build role hierarchies. A child role receives all
permissions from its parent, plus its own.

```tree
seed role, name guest
  seed allow
    case posts, text <read>
    case comments, text <read>

seed role, name member
  seed inherit, text <guest>
  seed allow
    case posts, text <read write>
    case comments, text <read write>

seed role, name admin
  seed inherit, text <member>
  seed allow
    case users, text <read write>
    case posts, text <read write delete>

seed role, name super-admin
  seed inherit, text <admin>
  seed allow
    case users, text <read write delete>
    case settings, text <read write>
    case billing, text <read write>
```

The chain flows upward. A `super-admin` inherits from `admin`, which
inherits from `member`, which inherits from `guest`. Each level adds
permissions on top of the parent.

## Policy Definitions

Use `seed policy` for access rules that go beyond simple role checks.
Policies combine multiple conditions with `hold any` (at least one must
pass) or `hold all` (every condition must pass).

```tree
seed policy, name edit-post
  take user, like user
  take post, like post
  hold any
    call has-role
      bind user, read user
      bind role, text <admin>
    meet and
      call is-equal
        bind a, read user/id
        bind b, read post/author-id
      call is-equal
        bind a, read post/status
        bind b, text <draft>
```

This policy allows editing a post if the user is an admin, or if the
user is the author and the post is still a draft.

### Combining Conditions

`hold any` passes when at least one child condition is true. `hold all`
passes when every child condition is true. Use `meet and` inside
`hold any` to group conditions that must all be true together. Use
`meet or` inside `hold all` when at least one of a subgroup must pass.

```tree
seed policy, name delete-comment
  take user, like user
  take comment, like comment
  hold any
    call has-role
      bind user, read user
      bind role, text <admin>
    meet and
      call is-equal
        bind a, read user/id
        bind b, read comment/author-id
      call has-role
        bind user, read user
        bind role, text <member>
```

## Route Guards

Use `hook boot` with `call require-auth` or `call require-role` to
protect routes. Guards run before the handler.

### Basic Authentication Guard

```tree
dock /api
  hook boot
    call parse-auth
    call require-auth

  dock /users
    task get
      call list-users
```

Every route under `/api` requires authentication.

### Role-Based Guards

```tree
dock /api
  hook boot
    call parse-auth
    call require-auth

  dock /admin
    hook boot
      call require-role
        bind role, text <admin>

    dock /users
      task get
        call list-users
```

The `/api/admin/users` route requires the `admin` role. The outer
`/api` guard still runs first.

### Per-Handler Guards

Apply guards to individual handlers when only some methods need
extra protection.

```tree
dock /api/admin
  hook boot
    call require-role
      bind role, text <admin>

  dock /users
    task get
      call list-users

    task delete
      hook boot
        call require-role
          bind role, text <super-admin>
      call toss-user
        bind id, read id
```

Anyone with `admin` can list users. Only `super-admin` can delete them.

## Nested Route Guards

Guards compose through nesting. Inner guards add to outer guards. They
do not replace them.

```tree
dock /api
  hook boot
    call parse-auth
    call require-auth

  dock /admin
    hook boot
      call require-role
        bind role, text <admin>

    dock /users
      task get
        call list-users
      task delete
        hook boot
          call require-role
            bind role, text <super-admin>
        call toss-user
          bind id, read id

    dock /settings
      task get
        call list-settings
      task put
        call save-settings
```

For `DELETE /api/admin/users`, three guards run in order:

1. `parse-auth` and `require-auth` from `/api`
2. `require-role admin` from `/admin`
3. `require-role super-admin` from the `delete` handler

## Resource-Level Policies

Use policies inside handlers to check ownership or other conditions
after loading data.

```tree
dock /posts/:post
  take path
    take post, name id
      like text

  task put
    hook boot
      call require-auth
    take body
      like hash
        link title, like text
        link content, like text

    save post
      call find-post
        bind id, read id

    call check-policy
      bind name, text <edit-post>
      bind user, read user
      bind post, read post
      halt kink

    call save-post
      bind id, read id
      bind title, read title
      bind content, read content
```

The `halt kink` propagates the policy failure as an error if the check
does not pass.

## Checking Permissions in Handlers

Use `call has-permission` to check specific resource actions within
handler logic.

```tree
dock /posts
  task get
    hook boot
      call require-auth

    save can-edit
      call has-permission
        bind user, read user
        bind resource, text <posts>
        bind action, text <write>

    save posts
      call list-posts

    fork test
      hook test
        read can-edit
      hook hold
        send json
          make result
            bind posts, read posts
            bind can-edit, wave true
      hook miss
        send json
          make result
            bind posts, read posts
            bind can-edit, wave false
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Define role | `seed role, name x` | `seed role, name admin` |
| Allow actions | `seed allow` + `case` | `case users, text <read write>` |
| Inherit role | `seed inherit, text <x>` | `seed inherit, text <admin>` |
| Define policy | `seed policy, name x` | `seed policy, name edit-post` |
| Any condition | `hold any` | at least one child must pass |
| All conditions | `hold all` | every child must pass |
| Group AND | `meet and` | all conditions in group must pass |
| Group OR | `meet or` | at least one in group must pass |
| Role check | `call has-role` | `bind role, text <admin>` |
| Equality check | `call is-equal` | `bind a, read x` / `bind b, read y` |
| Require auth | `call require-auth` | in `hook boot` |
| Require role | `call require-role` | `bind role, text <admin>` |
| Check policy | `call check-policy` | `bind name, text <edit-post>` |
| Check permission | `call has-permission` | `bind resource, text <posts>` |
| Route guard | `hook boot` | runs before handler |
| Error propagation | `halt kink` | propagate policy failure |
