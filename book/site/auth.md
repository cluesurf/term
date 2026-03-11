# Authentication

Seed supports multiple authentication strategies through declarative
configuration blocks. Combine `seed auth` with `dock` route handlers
to build complete auth flows.

## JWT Configuration

Declare JWT settings at the top of your auth module. The `seed auth`
block configures token signing, expiry, and claims.

```tree
seed auth, name jwt
  seed secret, read env/JWT_SECRET
  seed expire, mark 3600
  seed refresh, mark 604800
  seed algorithm, text <HS256>
  seed claim
    link sub, read user/id
    link role, read user/role
    link email, read user/email
```

| Field | Purpose |
|---|---|
| `seed secret` | Signing key, typically from environment |
| `seed expire` | Access token lifetime in seconds |
| `seed refresh` | Refresh token lifetime in seconds |
| `seed algorithm` | Signing algorithm (`HS256`, `HS384`, `RS256`, etc.) |
| `seed claim` | Token payload fields with `link` children |

Multiple claim sources:

```tree
seed auth, name jwt
  seed secret, read env/JWT_SECRET
  seed expire, mark 1800
  seed algorithm, text <RS256>
  seed claim
    link sub, read user/id
    link role, read user/role
    link email, read user/email
    link org, read user/org-id
    link iat, call now
```

## OAuth Configuration

Configure OAuth providers with `seed auth, name oauth`. Each provider
gets its own block.

```tree
seed auth, name oauth
  seed provider, text <google>
  seed client-id, read env/GOOGLE_CLIENT_ID
  seed client-secret, read env/GOOGLE_CLIENT_SECRET
  seed callback, text </auth/google/callback>
  seed scope
    text <openid>
    text <email>
    text <profile>
```

Multiple providers:

```tree
seed auth, name oauth
  seed provider, text <github>
  seed client-id, read env/GITHUB_CLIENT_ID
  seed client-secret, read env/GITHUB_CLIENT_SECRET
  seed callback, text </auth/github/callback>
  seed scope
    text <user:email>
    text <read:user>
```

OAuth callback handler:

```tree
dock /auth/google/callback
  task get
    take query
      like hash
        link code, like text
        link state, like text

    save token
      call exchange-oauth-code
        bind provider, text <google>
        bind code, read code
    save profile
      call fetch-oauth-profile
        bind provider, text <google>
        bind token, read token
    save user
      call find-or-make-user
        bind email, read profile/email
        bind name, read profile/name
        bind provider, text <google>
    save jwt
      call sign-jwt
        bind user, read user
    send back
      seed code, mark 302
      seed head
        link location, text </dashboard>
        link set-cookie, read jwt
```

## API Key Authentication

Configure API key auth for service-to-service communication.

```tree
seed auth, name api-key
  seed head, text <x-api-key>
  seed prefix, text <sk_>
```

Validate API keys in route handlers:

```tree
dock /api/v1
  hook boot
    take head
      link x-api-key, like text
    save key
      call find-api-key
        bind value, read x-api-key
    fork test
      hook test
        call is-none, read key
      hook hold
        bust unauthorized
          bind text, text <invalid api key>
```

## Session-Based Authentication

Configure session storage for server-rendered applications.

```tree
seed auth, name session
  seed secret, read env/SESSION_SECRET
  seed expire, mark 86400
  seed store, text <redis>
  seed cookie
    link name, text <sid>
    link path, text </>
    link http-only, wave true
    link secure, wave true
    link same-site, text <strict>
```

Session middleware:

```tree
dock /app
  hook boot
    call load-session

  dock /dashboard
    task get
      fork test
        hook test
          call is-none, read session/user
        hook hold
          send back
            seed code, mark 302
            seed head
              link location, text </login>
      send json, read session/user
```

## Login Flow

A complete login handler with validation, password checking, and
token generation.

```tree
dock /auth
  seed rate
    link window, mark 900000
    link max, mark 5

  dock /login
    task post
      take body
        like hash
          link email, like text
            mill email
          link password, like text

      save user
        call find-user-by-email
          bind email, read email

      fork test
        hook test
          call is-none, read user
        hook hold
          bust unauthorized
            bind text, text <invalid credentials>

      save valid
        call check-password
          bind input, read password
          bind hash, read user/password-hash

      fork test
        hook test
          call negate
            bind value, read valid
        hook hold
          bust unauthorized
            bind text, text <invalid credentials>

      save token
        call sign-jwt
          bind user, read user

      send json
        make session
          bind token, read token
          bind user
            make user-info
              bind id, read user/id
              bind name, read user/name
              bind role, read user/role
```

## Token Refresh

Issue new access tokens using a valid refresh token.

```tree
dock /auth/refresh
  task post
    take body
      like hash
        link refresh-token, like text

    save payload
      call verify-jwt
        bind token, read refresh-token
        bind kind, text <refresh>

    fork test
      hook test
        call is-none, read payload
      hook hold
        bust unauthorized
          bind text, text <invalid refresh token>

    save revoked
      call is-token-revoked
        bind token, read refresh-token

    fork test
      hook test
        read revoked
      hook hold
        bust unauthorized
          bind text, text <token revoked>

    save user
      call find-user-by-id
        bind id, read payload/sub

    save token
      call sign-jwt
        bind user, read user

    save new-refresh
      call sign-refresh-token
        bind user, read user

    send json
      make session
        bind token, read token
        bind refresh-token, read new-refresh
```

## Logout and Token Revocation

Invalidate tokens on logout by adding them to a revocation list.

```tree
dock /auth/logout
  task post
    take head
      link authorization, like text

    save token
      call parse-bearer
        bind value, read authorization

    call revoke-token
      bind token, read token

    send json
      seed code, mark 204
```

Revoke all sessions for a user:

```tree
dock /auth/revoke-all
  task post
    take head
      link authorization, like text

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization

    call revoke-all-tokens
      bind user-id, read payload/sub

    send json
      seed code, mark 204
```

## Password Hashing

Use `call hash-password` and `call check-password` for secure
password storage.

Hashing during registration:

```tree
dock /auth/register
  task post
    take body
      like hash
        link name, like text
        link email, like text
          mill email
        link password, like text

    save existing
      call find-user-by-email
        bind email, read email

    fork test
      hook test
        call is-some, read existing
      hook hold
        bust conflict
          bind text, text <email already registered>

    save hash
      call hash-password
        bind input, read password

    save user
      call make-user
        bind name, read name
        bind email, read email
        bind password-hash, read hash

    save token
      call sign-jwt
        bind user, read user

    send json
      seed code, mark 201
      make session
        bind token, read token
        bind user
          make user-info
            bind id, read user/id
            bind name, read user/name
```

Password change:

```tree
dock /auth/change-password
  task post
    take head
      link authorization, like text
    take body
      like hash
        link current, like text
        link next, like text

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization

    save user
      call find-user-by-id
        bind id, read payload/sub

    save valid
      call check-password
        bind input, read current
        bind hash, read user/password-hash

    fork test
      hook test
        call negate
          bind value, read valid
      hook hold
        bust unauthorized
          bind text, text <current password incorrect>

    save hash
      call hash-password
        bind input, read next

    call save-user-password
      bind id, read user/id
      bind password-hash, read hash

    send json
      seed code, mark 204
```

## Multi-Factor Authentication

Add TOTP-based two-factor authentication.

Enable MFA for a user:

```tree
dock /auth/mfa/enable
  task post
    take head
      link authorization, like text

    save payload
      call verify-jwt
        bind token
          call parse-bearer
            bind value, read authorization

    save secret
      call make-totp-secret

    save qr
      call make-totp-qr
        bind secret, read secret
        bind email, read payload/email

    send json
      make mfa-setup
        bind secret, read secret
        bind qr, read qr
```

Verify MFA code:

```tree
dock /auth/mfa/verify
  task post
    take body
      like hash
        link email, like text
          mill email
        link password, like text
        link code, like text

    save user
      call find-user-by-email
        bind email, read email

    fork test
      hook test
        call is-none, read user
      hook hold
        bust unauthorized
          bind text, text <invalid credentials>

    save valid
      call check-password
        bind input, read password
        bind hash, read user/password-hash

    fork test
      hook test
        call negate
          bind value, read valid
      hook hold
        bust unauthorized
          bind text, text <invalid credentials>

    save mfa-valid
      call verify-totp
        bind secret, read user/mfa-secret
        bind code, read code

    fork test
      hook test
        call negate
          bind value, read mfa-valid
      hook hold
        bust unauthorized
          bind text, text <invalid mfa code>

    save token
      call sign-jwt
        bind user, read user

    send json
      make session
        bind token, read token
```

## Rate Limiting on Auth Routes

Use `seed rate` to protect auth endpoints from brute force attacks.
The `window` is in milliseconds and `max` is the request limit per
window.

```tree
dock /auth
  seed rate
    link window, mark 900000
    link max, mark 5

  dock /login
    task post
      take body
        like hash
          link email, like text
          link password, like text
      call login
        bind email, read email
        bind password, read password
```

Per-route overrides:

```tree
dock /auth
  seed rate
    link window, mark 60000
    link max, mark 10

  dock /login
    seed rate
      link window, mark 900000
      link max, mark 5
    task post
      call login

  dock /register
    seed rate
      link window, mark 3600000
      link max, mark 3
    task post
      call register
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| JWT config | `seed auth, name jwt` | `seed secret, read env/JWT_SECRET` |
| Token expiry | `seed expire` | `seed expire, mark 3600` |
| Refresh expiry | `seed refresh` | `seed refresh, mark 604800` |
| Algorithm | `seed algorithm` | `seed algorithm, text <HS256>` |
| JWT claims | `seed claim` + `link` | `link sub, read user/id` |
| OAuth config | `seed auth, name oauth` | `seed provider, text <google>` |
| OAuth scope | `seed scope` | `text <openid>` |
| OAuth callback | `seed callback` | `seed callback, text </auth/google/callback>` |
| API key auth | `seed auth, name api-key` | `seed head, text <x-api-key>` |
| Session auth | `seed auth, name session` | `seed store, text <redis>` |
| Session cookie | `seed cookie` | `link http-only, wave true` |
| Password hash | `call hash-password` | `bind input, read password` |
| Password check | `call check-password` | `bind hash, read user/password-hash` |
| Token sign | `call sign-jwt` | `bind user, read user` |
| Token verify | `call verify-jwt` | `bind token, read token` |
| Token revoke | `call revoke-token` | `bind token, read token` |
| TOTP setup | `call make-totp-secret` | MFA secret generation |
| TOTP verify | `call verify-totp` | `bind code, read code` |
| Rate limiting | `seed rate` | `link max, mark 5` |
| Error response | `bust unauthorized` | `bind text, text <invalid credentials>` |
