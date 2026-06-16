# Rate Limiting (`seed rate`)

Control request throughput per route, per user, or per IP. Rate limits
protect against abuse and ensure fair usage. Define limits with
`seed rate` using window duration and maximum request count.

## Basic Rate Limit

Apply a global rate limit to all routes under a dock.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
```

This allows **100 requests per 60 seconds** across all routes under
`/api`.

## Per-Route Limits

Override the global limit for specific routes.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100

  dock /search
    seed rate
      link window, mark 60000
      link max, mark 30

    task get
      take query
        like hash
          link q, like text
      call search
        bind query, read q

  dock /users
    task get
      call list-users

  dock /auth/login
    seed rate
      link window, mark 900000
      link max, mark 5

    task post
      take body
        like hash
          link email, like text
          link password, like text
      call login
        bind email, read email
        bind password, read password
```

The `/search` endpoint allows 30 requests per minute. The `/auth/login`
endpoint allows only 5 requests per 15 minutes. All other `/api`
routes use the default 100 per minute.

## Rate Limit by Key

Control what identifies a unique client. Use `link key` to set the
rate limit key. Common keys are `ip`, `user`, and `api-key`.

### By IP Address (default)

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link key, text <ip>
```

### By Authenticated User

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 1000
    link key, text <user>
```

### By API Key

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 500
    link key, text <api-key>
```

### Custom Key Expression

Use a custom key from request data.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link key, read head/x-tenant-id
```

## Tiered Rate Limits

Apply different limits based on user tier or plan. Use `fork case`
to select the appropriate limit.

```tree
dock /api
  hook boot
    take head
      link authorization, like text
        need false

    save user
      call parse-auth
        bind token, read authorization

    fork case, read user/plan
      case free
        call apply-rate-limit
          bind window, mark 60000
          bind max, mark 10
          bind key, read user/id
      case pro
        call apply-rate-limit
          bind window, mark 60000
          bind max, mark 100
          bind key, read user/id
      case enterprise
        call apply-rate-limit
          bind window, mark 60000
          bind max, mark 1000
          bind key, read user/id
```

## Sliding Window

Use a sliding window algorithm instead of fixed windows. This
prevents burst traffic at window boundaries.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link strategy, text <sliding>
```

## Fixed Window

The default strategy. Resets the counter at fixed intervals.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link strategy, text <fixed>
```

## Token Bucket

Allow bursts up to a maximum, then refill at a steady rate.

```tree
dock /api
  seed rate
    link strategy, text <token-bucket>
    link max, mark 100
    link refill, mark 10
    link interval, mark 1000
```

This allows bursts of up to 100 requests, refilling 10 tokens per
second.

## Block Duration

When a client exceeds the limit, block them for a duration with
`link block`.

```tree
dock /api/auth
  seed rate
    link window, mark 300000
    link max, mark 5
    link block, mark 900000
```

After 5 requests in 5 minutes, the client is blocked for 15 minutes.

## Rate Limit Headers

The framework automatically adds rate limit headers to responses.

| Header | Purpose |
|---|---|
| `X-RateLimit-Limit` | Maximum requests allowed in the window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |
| `Retry-After` | Seconds to wait before retrying (on 429) |

## Custom Rate Limit Response

Customize the response when a client is rate limited.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link response
      seed code, mark 429
      make error
        bind text, text <too many requests>
        bind retry-after, read rate/reset
```

## Exempt Routes

Skip rate limiting for health checks or internal routes.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100

  dock /health
    seed rate
      link skip, wave true
    task get
      send json
        make health
          bind status, text <ok>

  dock /internal
    seed rate
      link skip, wave true
    hook boot
      call check-internal-token
```

## Rate Limit by Method

Apply different limits based on HTTP method.

```tree
dock /api/posts
  task get
    seed rate
      link window, mark 60000
      link max, mark 200
    call list-posts

  task post
    seed rate
      link window, mark 60000
      link max, mark 10
    take body
      like hash
        link title, like text
        link body, like text
    call make-post
      bind title, read title
      bind body, read body
```

## Distributed Rate Limiting

Use a shared store for rate limiting across multiple server instances.

```tree
seed rate
  link store, text <redis>
  link store-url, read env/REDIS_URL
  link prefix, text <rate:>
```

## Full Example

A complete rate limiting configuration with global limits, per-route
overrides, tiered plans, and custom responses.

```tree
seed rate
  link store, text <redis>
  link store-url, read env/REDIS_URL

dock /api
  seed rate
    link window, mark 60000
    link max, mark 100
    link key, text <ip>
    link strategy, text <sliding>

  dock /health
    seed rate
      link skip, wave true
    task get
      send json
        make health
          bind status, text <ok>

  dock /auth
    dock /login
      seed rate
        link window, mark 900000
        link max, mark 5
        link block, mark 1800000
        link key, text <ip>

      task post
        take body
          like hash
            link email, like text
            link password, like text
        call login
          bind email, read email
          bind password, read password

    dock /register
      seed rate
        link window, mark 3600000
        link max, mark 3
        link key, text <ip>

      task post
        take body
          like hash
            link name, like text
            link email, like text
            link password, like text
        call register
          bind name, read name
          bind email, read email
          bind password, read password

  dock /users
    hook boot
      take head
        link authorization, like text
      save user
        call verify-jwt
          bind token
            call parse-bearer
              bind value, read authorization
          halt kink

      fork case, read user/plan
        case free
          call apply-rate-limit
            bind window, mark 60000
            bind max, mark 20
            bind key, read user/id
        case pro
          call apply-rate-limit
            bind window, mark 60000
            bind max, mark 200
            bind key, read user/id
        case enterprise
          call apply-rate-limit
            bind window, mark 60000
            bind max, mark 2000
            bind key, read user/id

    task get
      call list-users

    task post
      seed rate
        link window, mark 60000
        link max, mark 5
        link key, text <user>
      take body
        like hash
          link name, like text
          link email, like text
      call make-user
        bind name, read name
        bind email, read email

  dock /search
    seed rate
      link window, mark 60000
      link max, mark 30
      link key, text <ip>
      link response
        seed code, mark 429
        make error
          bind text, text <search rate limit exceeded>
          bind retry-after, read rate/reset

    task get
      take query
        like hash
          link q, like text
      call search
        bind query, read q
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Rate limit block | `seed rate` | attach to `dock` or `task` |
| Window duration | `link window` | `link window, mark 60000` (ms) |
| Max requests | `link max` | `link max, mark 100` |
| Rate key | `link key` | `text <ip>`, `text <user>`, `text <api-key>` |
| Custom key | `link key, read x` | `link key, read head/x-tenant-id` |
| Block duration | `link block` | `link block, mark 900000` (ms) |
| Strategy | `link strategy` | `text <sliding>`, `text <fixed>`, `text <token-bucket>` |
| Token refill | `link refill` | `link refill, mark 10` |
| Skip limit | `link skip` | `link skip, wave true` |
| Custom response | `link response` | custom 429 body |
| Distributed store | `link store` | `link store, text <redis>` |
| Tiered limits | `fork case` + `call apply-rate-limit` | per-plan limits |
| Per-method limit | `seed rate` inside `task` | method-specific |
| Exempt routes | `seed rate` + `link skip` | health checks |
