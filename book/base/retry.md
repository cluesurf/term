# Retry (`seed retry`)

Retry in Seed defines strategies for handling transient failures.
Configure max attempts, delays, backoff curves, and error filters.
Retry wraps any fallible operation with automatic recovery logic.

## Basic Retry

Wrap a call with a simple retry policy.

```tree
seed retry
  name <basic>
  seed max, mark 3
  seed delay, mark 1000

task fetch-data
  take url, like text

  save result, call http-get
    bind url, read url
    bind retry, <basic>
    halt kink

  send back, read result
```

**`seed retry`** defines a named retry policy.
**`seed max`** is the maximum number of attempts (including the first).
**`seed delay`** is the wait time in milliseconds between attempts.
**`bind retry`** on a call applies the named policy.

## Exponential Backoff

Increase delay between retries with exponential backoff.

```tree
seed retry
  name <exponential>
  seed max, mark 5
  seed delay, mark 500
  seed backoff, <exponential>
  seed factor, mark 2
```

Attempt delays: 500ms, 1000ms, 2000ms, 4000ms.

**`seed backoff`** sets the backoff strategy.
**`seed factor`** is the multiplier applied after each attempt.

Options for `seed backoff`:
- `<constant>` repeats the same delay (default)
- `<linear>` adds delay each time (500, 1000, 1500, 2000)
- `<exponential>` multiplies by factor (500, 1000, 2000, 4000)

## Max Delay Cap

Prevent delays from growing too large.

```tree
seed retry
  name <capped>
  seed max, mark 10
  seed delay, mark 100
  seed backoff, <exponential>
  seed factor, mark 2
  seed max-delay, mark 5000
```

Without `seed max-delay`, exponential backoff with 10 retries would
reach 51 seconds on the last attempt. **`seed max-delay`** caps it
at 5 seconds.

## Jitter

Add randomness to prevent thundering herd.

```tree
seed retry
  name <jittered>
  seed max, mark 5
  seed delay, mark 1000
  seed backoff, <exponential>
  seed factor, mark 2
  seed jitter, wave true
```

**`seed jitter`** adds random variation to each delay. The actual
delay is between 0 and the calculated delay. This spreads out retry
storms when many clients fail at the same time.

## Conditional Retry

Retry only on specific error types.

```tree
seed retry
  name <network-only>
  seed max, mark 3
  seed delay, mark 2000
  seed on
    case <timeout>
    case <connection-refused>
    case <dns-error>
```

```tree
seed retry
  name <server-errors>
  seed max, mark 3
  seed delay, mark 1000
  seed on
    case <http-500>
    case <http-502>
    case <http-503>
    case <http-429>
```

**`seed on`** lists which error types trigger a retry.
Unlisted errors fail immediately without retrying.
Without `seed on`, all errors trigger retry.

## Circuit Breaker

Stop retrying when a service is clearly down.

```tree
seed retry
  name <with-breaker>
  seed max, mark 3
  seed delay, mark 1000
  seed breaker
    seed threshold, mark 5
    seed window, mark 60000
    seed cooldown, mark 30000
```

**`seed breaker`** enables circuit breaker behavior.
**`seed threshold`** is failures before the circuit opens.
**`seed window`** is the time window for counting failures (ms).
**`seed cooldown`** is how long the circuit stays open before
allowing a test request.

States:
- **Closed**: normal operation, failures counted.
- **Open**: all requests fail immediately, no retry.
- **Half-open**: one test request allowed after cooldown.

## Timeout with Retry

Combine timeout and retry for resilient calls.

```tree
seed retry
  name <timed>
  seed max, mark 3
  seed delay, mark 500
  seed timeout, mark 5000

task fetch-api
  take endpoint, like text

  save result, call http-get
    bind url, read endpoint
    bind retry, <timed>
    halt kink

  send back, read result
```

**`seed timeout`** sets the max time per attempt in milliseconds.
If a single attempt exceeds this, it is cancelled and counts as a
failure. The retry policy then decides whether to try again.

## Inline Retry

Define retry behavior inline without a named policy.

```tree
task send-notification
  take user-id, like uuid
  take message, like text

  save result, call send-push
    bind user-id, read user-id
    bind message, read message
    bind retry
      seed max, mark 3
      seed delay, mark 2000
      seed backoff, <exponential>
      seed factor, mark 2
    halt kink

  send back, read result
```

Inline retry is useful for one-off policies. Named policies are
better when the same strategy applies to multiple calls.

## Retry with Fallback

Execute alternate logic after all retries fail.

```tree
task get-user-data
  take user-id, like uuid

  save result, call fetch-user
    bind id, read user-id
    bind retry, <exponential>

  fork test
    hook test, read result/ok
    hook hold
      send back, read result/value
    hook miss
      save cached, call get-cached-user
        bind id, read user-id
      fork test
        hook test, read cached
        hook hold
          send back, read cached
        hook miss
          halt kink, <user data unavailable>
```

After retries are exhausted, fall back to cached data or a default.

## Composition with Events

Log retry attempts as events.

```tree
seed retry
  name <observed>
  seed max, mark 5
  seed delay, mark 1000
  seed backoff, <exponential>
  seed factor, mark 2

  hook attempt
    take count, like u32
    take error, like kink
    call emit-event
      bind type, <retry-attempt>
      bind data
        bind attempt, read count
        bind error, read error/message

  hook exhaust
    take error, like kink
    call emit-event
      bind type, <retry-exhausted>
      bind data
        bind error, read error/message
```

**`hook attempt`** fires before each retry (not the first attempt).
**`hook exhaust`** fires when all retries are used up.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed retry` | Define a retry policy |
| `name` | Policy identifier |
| `seed max` | Maximum number of attempts |
| `seed delay` | Base delay between retries (ms) |
| `seed backoff` | Backoff strategy (constant, linear, exponential) |
| `seed factor` | Backoff multiplier |
| `seed max-delay` | Cap on delay growth |
| `seed jitter` | Add random variation to delays |
| `seed timeout` | Per-attempt timeout (ms) |
| `seed on` | Error types that trigger retry |
| `case` | Individual error type in `seed on` |
| `seed breaker` | Circuit breaker configuration |
| `seed threshold` | Failures before circuit opens |
| `seed window` | Failure counting window (ms) |
| `seed cooldown` | Open-state duration before half-open (ms) |
| `bind retry` | Apply policy to a call |
| `hook attempt` | Callback before each retry |
| `hook exhaust` | Callback when retries are used up |
