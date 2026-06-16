# Webhooks (`dock` + `task post`)

Handle inbound webhooks and emit outbound webhook calls. Verify
signatures, route by event type, and process payloads. Webhooks use
standard `dock` routes with signature verification middleware.

## Basic Inbound Webhook

```tree
dock /webhooks/stripe
  task post
    take head
      link stripe-signature, like text
    take body
      like hash
        link type, like text
        link data, like hash

    call verify-stripe-signature
      bind payload, read body
      bind signature, read stripe-signature
      bind secret, read env/STRIPE_WEBHOOK_SECRET
      halt kink

    fork case, read type
      case checkout.session.completed
        call handle-checkout
          bind data, read data
      case invoice.paid
        call handle-invoice-paid
          bind data, read data
      case customer.subscription.deleted
        call handle-cancel
          bind data, read data

    send json
      make result
        bind received, wave true
```

## GitHub Webhook

Verify the GitHub HMAC signature and route by event header.

```tree
dock /webhooks/github
  task post
    take head
      link x-hub-signature-256, like text
      link x-github-event, like text
    take body
      like hash

    call verify-github-signature
      bind payload, read body
      bind signature, read x-hub-signature-256
      bind secret, read env/GITHUB_WEBHOOK_SECRET
      halt kink

    fork case, read x-github-event
      case push
        call handle-push
          bind commits, read body/commits
          bind ref, read body/ref
      case pull_request
        call handle-pull-request
          bind action, read body/action
          bind pr, read body/pull-request
      case issues
        call handle-issue
          bind action, read body/action
          bind issue, read body/issue

    send json
      seed code, mark 200
```

## Signature Verification

**Always verify webhook signatures** before processing. Each provider
uses a different algorithm.

### Stripe (HMAC-SHA256 with timestamp)

```tree
task verify-stripe-signature
  take payload, like hash
  take signature, like text
  take secret, like text

  save parts
    call parse-stripe-signature
      bind value, read signature

  save expected
    call hmac-sha256
      bind key, read secret
      bind data
        call concat
          bind a, read parts/timestamp
          bind b, text <.>
          bind c
            call to-json
              bind value, read payload

  fork test
    hook test
      call negate
        bind value
          call is-equal
            bind a, read expected
            bind b, read parts/hash
    hook hold
      halt kink
        make kink
          bind code, text <invalid-signature>
          bind text, text <webhook signature mismatch>
```

### Generic HMAC-SHA256

```tree
task verify-hmac-signature
  take payload, like text
  take signature, like text
  take secret, like text

  save expected
    call hmac-sha256
      bind key, read secret
      bind data, read payload

  fork test
    hook test
      call negate
        bind value
          call is-equal
            bind a, read expected
            bind b, read signature
    hook hold
      halt kink
        make kink
          bind code, text <invalid-signature>
          bind text, text <signature verification failed>
```

## Outbound Webhooks

Emit webhooks to external services. Register webhook URLs and call
them when events occur.

### Webhook Registration

```tree
dock /webhooks
  task post
    take body
      like hash
        link url, like text
          mill url
        link events, like list
        link secret, like text
          need false

    save hook
      call make-webhook
        bind url, read url
        bind events, read events
        bind secret, read secret

    send json
      seed code, mark 201
      read hook
```

### Sending Outbound Webhooks

```tree
task emit-webhook
  take event, like text
  take data, like hash

  save hooks
    call find-webhooks-by-event
      bind event, read event

  walk list, read hooks
    hook next
      take site, name hook

      save payload
        make webhook-payload
          bind event, read event
          bind data, read data
          bind timestamp, call now

      save signature
        call hmac-sha256
          bind key, read hook/secret
          bind data
            call to-json
              bind value, read payload

      call http-post
        bind url, read hook/url
        bind body, read payload
        bind head
          make head
            bind content-type, text <application/json>
            bind x-webhook-signature, read signature
        halt kink
```

## Webhook with Retry

Retry failed deliveries with exponential backoff.

```tree
task emit-webhook-with-retry
  take event, like text
  take data, like hash
  take max-retries, like u32
    base mark 3

  save hooks
    call find-webhooks-by-event
      bind event, read event

  walk list, read hooks
    hook next
      take site, name hook

      call queue-webhook-delivery
        bind hook-id, read hook/id
        bind event, read event
        bind data, read data
        bind max-retries, read max-retries

task process-webhook-delivery
  take hook-id, like text
  take event, like text
  take data, like hash
  take attempt, like u32
  take max-retries, like u32

  save hook
    call find-webhook
      bind id, read hook-id

  save payload
    make webhook-payload
      bind event, read event
      bind data, read data
      bind attempt, read attempt

  save result
    call http-post
      bind url, read hook/url
      bind body, read payload

  fork case, read result/form
    case okay
      call log-webhook-success
        bind hook-id, read hook-id
        bind event, read event
    case error
      fork test
        hook test
          call is-below
            bind a, read attempt
            bind b, read max-retries
        hook hold
          call queue-webhook-delivery
            bind hook-id, read hook-id
            bind event, read event
            bind data, read data
            bind attempt
              call add
                bind a, read attempt
                bind b, mark 1
            bind max-retries, read max-retries
            bind delay
              call power
                bind base, mark 2
                bind exp, read attempt
        hook miss
          call log-webhook-failure
            bind hook-id, read hook-id
            bind event, read event
            bind attempts, read attempt
```

## Webhook Event Routing

Use `fork case` to route different event types to specific handlers.

```tree
dock /webhooks/payments
  task post
    take head
      link x-webhook-signature, like text
    take body
      like hash
        link event, like text
        link data, like hash

    call verify-hmac-signature
      bind payload
        call to-json
          bind value, read body
      bind signature, read x-webhook-signature
      bind secret, read env/PAYMENT_WEBHOOK_SECRET
      halt kink

    fork case, read event
      case payment.success
        call handle-payment-success
          bind amount, read data/amount
          bind customer, read data/customer-id
      case payment.failed
        call handle-payment-failed
          bind reason, read data/reason
          bind customer, read data/customer-id
      case refund.created
        call handle-refund
          bind amount, read data/amount
          bind payment-id, read data/payment-id
      case dispute.opened
        call handle-dispute
          bind dispute, read data

    send json
      make result
        bind received, wave true
```

## Full Example

A complete webhook system with inbound handling, outbound delivery,
and management endpoints.

```tree
dock /webhooks
  task post
    take head
      link authorization, like text
    take body
      like hash
        link url, like text
          mill url
        link events, like list
        link secret, like text

    call verify-jwt
      bind token
        call parse-bearer
          bind value, read authorization
      halt kink

    save hook
      call make-webhook
        bind url, read url
        bind events, read events
        bind secret, read secret

    send json
      seed code, mark 201
      read hook

  task get
    take head
      link authorization, like text

    call verify-jwt
      bind token
        call parse-bearer
          bind value, read authorization
      halt kink

    save hooks
      call list-webhooks

    send json, read hooks

dock /webhooks/stripe
  task post
    take head
      link stripe-signature, like text
    take body
      like hash
        link type, like text
        link data, like hash

    call verify-stripe-signature
      bind payload, read body
      bind signature, read stripe-signature
      bind secret, read env/STRIPE_WEBHOOK_SECRET
      halt kink

    fork case, read type
      case checkout.session.completed
        call handle-checkout
          bind session, read data/object
      case invoice.paid
        call handle-invoice
          bind invoice, read data/object
      case customer.subscription.updated
        call handle-subscription-update
          bind subscription, read data/object

    call emit-webhook
      bind event, read type
      bind data, read data

    send json
      make result
        bind received, wave true
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Webhook route | `dock /webhooks/x` + `task post` | `dock /webhooks/stripe` |
| Signature header | `take head` + `link` | `link stripe-signature, like text` |
| Verify signature | `call verify-*-signature` | `call verify-stripe-signature` |
| Event routing | `fork case, read type` | `case checkout.session.completed` |
| Error on bad sig | `halt kink` | child of verify call |
| Outbound webhook | `call http-post` | `bind url, read hook/url` |
| HMAC signing | `call hmac-sha256` | `bind key, read secret` |
| Webhook registration | `call make-webhook` | `bind url, read url` |
| Retry delivery | `call queue-webhook-delivery` | exponential backoff |
| Event emission | `call emit-webhook` | `bind event, read type` |
