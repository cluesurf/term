# Security (`seed csp` / `seed security-head`)

Declare content security policies and security headers. CSP controls
which resources the browser can load. Security headers add protection
against common web attacks like clickjacking and XSS.

## Basic CSP

```tree
seed csp
  link default-src, text <'self'>
  link script-src, text <'self'>
  link style-src, text <'self'>
  link img-src, text <'self'>
```

## CSP with External Resources

Allow specific external domains for scripts, styles, fonts, and
images.

```tree
seed csp
  link default-src, text <'self'>
  link script-src, text <'self' https://cdn.example.com>
  link style-src, text <'self' https://fonts.googleapis.com>
  link font-src, text <'self' https://fonts.gstatic.com>
  link img-src, text <'self' https://images.example.com data:>
  link connect-src, text <'self' https://api.example.com>
```

## Strict CSP

A strict policy using nonces for inline scripts. No `unsafe-inline`
or `unsafe-eval` allowed.

```tree
seed csp
  link default-src, text <'none'>
  link script-src, text <'self' 'nonce-{nonce}'>
  link style-src, text <'self' 'nonce-{nonce}'>
  link img-src, text <'self'>
  link font-src, text <'self'>
  link connect-src, text <'self'>
  link base-uri, text <'self'>
  link form-action, text <'self'>
  link frame-ancestors, text <'none'>
  link object-src, text <'none'>
  link upgrade-insecure-requests, wave true
```

The `{nonce}` placeholder is replaced with a unique value per request.
Reference it in inline scripts:

```tree
zone script
  seed nonce, read csp-nonce
  text <console.log('safe')>
```

## CSP Report-Only

Test a CSP without enforcing it. Violations are reported but not
blocked.

```tree
seed csp
  link report-only, wave true
  link default-src, text <'self'>
  link script-src, text <'self'>
  link report-uri, text </csp-report>
  link report-to, text <csp-endpoint>
```

Handle CSP violation reports:

```tree
dock /csp-report
  task post
    take body
      like hash

    call log-csp-violation
      bind report, read body

    send json
      seed code, mark 204
```

## Security Headers

Use `seed security-head` to set common security response headers
in one block.

```tree
seed security-head
  link strict-transport-security, text <max-age=31536000; includeSubDomains; preload>
  link x-content-type-options, text <nosniff>
  link x-frame-options, text <DENY>
  link x-xss-protection, text <0>
  link referrer-policy, text <strict-origin-when-cross-origin>
  link permissions-policy, text <camera=(), microphone=(), geolocation=()>
```

### Header Descriptions

| Header | Purpose |
|---|---|
| `strict-transport-security` | Force HTTPS connections. Include subdomains and preload list. |
| `x-content-type-options` | Prevent MIME type sniffing. Always set to `nosniff`. |
| `x-frame-options` | Prevent clickjacking. `DENY` blocks all framing. |
| `x-xss-protection` | Disable browser XSS filter (modern CSP is better). Set to `0`. |
| `referrer-policy` | Control referrer information sent with requests. |
| `permissions-policy` | Restrict browser features like camera and microphone. |

## CORS Configuration

Configure cross-origin resource sharing alongside security headers.

```tree
seed cors
  link origin, text <https://app.example.com>
  link method, text <GET, POST, PUT, DELETE>
  link head, text <Authorization, Content-Type, X-Request-ID>
  link max-age, mark 86400
  link credentials, wave true
```

Multiple allowed origins:

```tree
seed cors
  link origin
    list text
      text <https://app.example.com>
      text <https://admin.example.com>
  link method, text <GET, POST, PUT, DELETE>
  link head, text <Authorization, Content-Type>
```

## Per-Route Security

Apply different security policies to different routes.

```tree
dock /api
  seed cors
    link origin, text <https://app.example.com>
    link method, text <GET, POST, PUT, DELETE>
    link head, text <Authorization, Content-Type>
    link credentials, wave true

  seed csp
    link default-src, text <'none'>
    link connect-src, text <'self'>

dock /embed
  seed csp
    link default-src, text <'self'>
    link frame-ancestors, text <https://partner.example.com>

  seed security-head
    link x-frame-options, text <ALLOW-FROM https://partner.example.com>
```

## CORS + CSP Together

A common pattern for APIs that serve both web apps and embedded
widgets.

```tree
seed security-head
  link strict-transport-security, text <max-age=31536000; includeSubDomains>
  link x-content-type-options, text <nosniff>
  link x-frame-options, text <SAMEORIGIN>
  link referrer-policy, text <strict-origin-when-cross-origin>

seed csp
  link default-src, text <'self'>
  link script-src, text <'self' https://cdn.example.com>
  link style-src, text <'self' 'unsafe-inline'>
  link img-src, text <'self' https://images.example.com data:>
  link connect-src, text <'self' https://api.example.com wss://ws.example.com>
  link frame-ancestors, text <'self'>

seed cors
  link origin, text <https://app.example.com>
  link method, text <GET, POST, PUT, DELETE, PATCH>
  link head, text <Authorization, Content-Type, X-Request-ID>
  link max-age, mark 86400
  link credentials, wave true
```

## Permissions Policy

Fine-grained control over browser features.

```tree
seed security-head
  link permissions-policy
    call concat
      bind a, text <camera=()>
      bind b, text <, microphone=()>
      bind c, text <, geolocation=(self)>
      bind d, text <, payment=(self "https://pay.example.com")>
      bind e, text <, fullscreen=(self)>
```

Alternatively, use `seed permissions` for a structured format:

```tree
seed permissions
  link camera, text <()>
  link microphone, text <()>
  link geolocation, text <(self)>
  link payment, text <(self "https://pay.example.com")>
  link fullscreen, text <(self)>
  link autoplay, text <(self)>
  link display-capture, text <()>
```

## Rate Limiting Headers

Add rate limit information to responses.

```tree
dock /api
  seed rate
    link window, mark 60000
    link max, mark 100

  hook boot
    call set-rate-headers
      bind remaining, read rate/remaining
      bind limit, read rate/max
      bind reset, read rate/reset
```

## Full Example

A complete security configuration for a production application.

```tree
seed security-head
  link strict-transport-security, text <max-age=63072000; includeSubDomains; preload>
  link x-content-type-options, text <nosniff>
  link x-frame-options, text <DENY>
  link x-xss-protection, text <0>
  link referrer-policy, text <strict-origin-when-cross-origin>
  link permissions-policy, text <camera=(), microphone=(), geolocation=()>

seed csp
  link default-src, text <'none'>
  link script-src, text <'self' 'nonce-{nonce}'>
  link style-src, text <'self' https://fonts.googleapis.com 'nonce-{nonce}'>
  link font-src, text <'self' https://fonts.gstatic.com>
  link img-src, text <'self' https://images.example.com data:>
  link connect-src, text <'self' https://api.example.com wss://ws.example.com>
  link media-src, text <'self'>
  link frame-src, text <'none'>
  link frame-ancestors, text <'none'>
  link base-uri, text <'self'>
  link form-action, text <'self'>
  link object-src, text <'none'>
  link upgrade-insecure-requests, wave true

dock /api
  seed cors
    link origin
      list text
        text <https://app.example.com>
        text <https://admin.example.com>
    link method, text <GET, POST, PUT, DELETE, PATCH>
    link head, text <Authorization, Content-Type, X-Request-ID>
    link max-age, mark 86400
    link credentials, wave true

  seed csp
    link default-src, text <'none'>
    link connect-src, text <'self'>

  seed rate
    link window, mark 60000
    link max, mark 100

  dock /auth
    seed rate
      link window, mark 900000
      link max, mark 5

dock /embed
  seed csp
    link default-src, text <'self'>
    link script-src, text <'self'>
    link frame-ancestors, text <https://partner.example.com https://other.example.com>

  seed cors
    link origin, text <https://partner.example.com>
    link method, text <GET>

dock /csp-report
  task post
    take body
      like hash
    call log-csp-violation
      bind report, read body
    send json
      seed code, mark 204
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| CSP block | `seed csp` | content security policy |
| Default source | `link default-src` | `text <'self'>` |
| Script source | `link script-src` | `text <'self' 'nonce-{nonce}'>` |
| Style source | `link style-src` | `text <'self'>` |
| Image source | `link img-src` | `text <'self' data:>` |
| Connect source | `link connect-src` | `text <'self' https://api.com>` |
| Frame ancestors | `link frame-ancestors` | `text <'none'>` |
| Upgrade insecure | `link upgrade-insecure-requests` | `wave true` |
| Report only | `link report-only` | `wave true` |
| Report URI | `link report-uri` | `text </csp-report>` |
| Security headers | `seed security-head` | all security headers |
| HSTS | `link strict-transport-security` | `text <max-age=31536000>` |
| No sniff | `link x-content-type-options` | `text <nosniff>` |
| Frame options | `link x-frame-options` | `text <DENY>` |
| Referrer policy | `link referrer-policy` | `text <strict-origin...>` |
| Permissions | `link permissions-policy` | feature restrictions |
| CORS | `seed cors` | cross-origin settings |
| CORS origin | `link origin` | `text <https://app.com>` |
| CORS credentials | `link credentials` | `wave true` |
| Per-route CSP | `seed csp` inside `dock` | route-specific policy |
