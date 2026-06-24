# Auth

Authentication is built from ordinary [route handlers](routes.md) plus a session or token store. A login handler verifies a credential and issues a token. Later requests carry the token, and a guard or middleware verifies it before the protected handler runs. The same patterns cover sessions, JWTs, OAuth, and API keys.

Maps to: hand-rolled auth over your router (Passport-style strategies), but the handlers are plain `dock` tasks.

## Cheatsheet

| Piece | How |
| --- | --- |
| Login route | `dock /auth/login` with `task post` |
| Read a credential | `read request/body` then parse |
| Hash a password | `call hash-password` |
| Check a password | `call check-password` |
| Issue a token | `call sign-jwt` (or set a session cookie) |
| Verify a token | `call verify-jwt` |
| Read a bearer header | `call parse-bearer` |
| Protect a group | a guard task that runs before the handler |
| Revoke a token | `call revoke-token` |
| Send a redirect | `make response` with a `30x` status and a `location` header |

These verbs are library tasks. The exact names depend on the auth library you import. The shape below is what an app writes.

## A login handler

Verify the credential, then issue a token. On failure, `bust` an unauthorized error.

```tree
dock /auth/login
  task post
    save creds
      call parse-login
        read request/body
    save user
      call find-user-by-email
        read creds/email
    fork test
      hook test
        call is-none, read user
      hook hold
        bust unauthorized
          bind text, text <invalid credentials>
    save valid
      call check-password
        bind input, read creds/password
        bind hash, read user/password-hash
    fork test
      hook test
        call not, read valid
      hook hold
        bust unauthorized
          bind text, text <invalid credentials>
    save token
      call sign-jwt
        bind user, read user
    send back
      make response
        bind status, code 200
        bind body
          call to-json
            make session
              bind token, read token
```

## Registration with password hashing

Hash the password before storing it. Reject a duplicate email with a conflict.

```tree
dock /auth/register
  task post
    save body
      call parse-register
        read request/body
    save existing
      call find-user-by-email
        read body/email
    fork test
      hook test
        call is-some, read existing
      hook hold
        bust conflict
          bind text, text <email already registered>
    save hash
      call hash-password
        bind input, read body/password
    save user
      call make-user
        bind name, read body/name
        bind email, read body/email
        bind password-hash, read hash
    send back
      make response
        bind status, code 201
        bind body
          call to-json, read user
```

## Verifying on a protected route

Pull the token off the `authorization` header, verify it, and reject if invalid.

```tree
dock /me
  task get
    save token
      call parse-bearer
        call header
          read request
          text <authorization>
    save payload
      call verify-jwt
        bind token, read token
    fork test
      hook test
        call is-none, read payload
      hook hold
        bust unauthorized
          bind text, text <not signed in>
    save user
      call find-user-by-id
        read payload/sub
    send back
      make response
        bind status, code 200
        bind body
          call to-json, read user
```

## Sessions

For server-rendered pages, store a session and set its id in a cookie on login. On each request, load the session by cookie and check it. A page route that needs a user redirects to `/login` when the session is absent.

```tree
dock /dashboard
  task get
    save session
      call load-session, read request
    fork test
      hook test
        call is-none, read session/user
      hook hold
        send back
          make response
            bind status, code 302
            bind body, text </login>
    send back
      call render-dashboard, read session/user
```

A `302` response with the target path is how a handler redirects. The transport sets the `location` header.

## OAuth

An OAuth callback is a normal route. Exchange the code for a token, fetch the profile, find or create the user, issue your own session or JWT, then redirect to the app.

```tree
dock /auth/google/callback
  task get
    save code
      call query
        read request
        text <code>
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
    save jwt
      call sign-jwt
        bind user, read user
    send back
      make response
        bind status, code 302
        bind body, text </dashboard>
```

## Token refresh and revocation

Issue a new access token from a valid refresh token, checking a revocation list first. On logout, add the token to that list. The flow is the same shape: parse the token, verify it, check it is not revoked, then mint or revoke.

## Guards on the client

For client page routes, a guard task runs before a [zone](components.md) mounts. If the user is not allowed, redirect. See [navigation](navigation.md) for client redirects and [routes](routes.md) for the route table.
