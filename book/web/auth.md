# Auth

Authentication is built from ordinary [route handlers](routes.md) plus a session or token store. A login handler verifies a credential and issues a token. Later requests carry the token, and the protected handler verifies it before doing anything else. The same patterns cover sessions, signed tokens, OAuth, and API keys.

Maps to: hand-rolled auth over your router (Passport-style strategies), but the handlers are plain tasks in `route` records.

**Term ships no auth library.** There is no password hashing, JWT, session store, or cookie task. What the standard library does provide is `@term/base/code/cryptography/hmac` (`hmac`, `sha256`, `verify-hmac`, all async, and `is-equal-secret` for a constant-time compare), `digest` and `random`. And a server `request` carries `method`, `path` and `body` only, with no headers, so a token reaches a handler in the body or the path. The samples below declare the tasks an app writes for itself as signatures with no body, which compile as stubs.

## Cheatsheet

| Piece | How |
| --- | --- |
| Login route | a `route` record, `POST` on `/auth/login` |
| Read a credential | `read request/body`, then parse it |
| Check a password | your own task, comparing with `is-equal-secret` |
| Issue a token | your own task, signing with `hmac` |
| Verify a token | `verify-hmac` against the same key |
| Reject | a response with status `401` |
| Redirect | not provided. A `response` has no `location` header |

## A login handler

Verify the credential, then issue a token. On failure, answer `401`.

```tree
load @term/site/code/http/http
  find request
  find response

load @term/base/code/maybe
  find maybe

form login
  link email, like text
  link password, like text

form user
  link id, like text
  link email, like text
  link password-hash, like text

# the app's own tasks: Term ships none of these
task parse-login
  take body, like text
  like login

task find-user-by-email
  take email, like text
  like maybe user

task check-password
  take input, like text
  take hash, like text
  like boolean

task sign-token
  take user, like user
  like text

task refuse
  like response
  send back
    make response
      bind status, code 401
      bind body, text <invalid credentials>

task log-in
  take request, like request
  take params, like hash
  like response
  save creds
    call parse-login
      read request/body
  save found
    call find-user-by-email
      read creds/email
  fork case, read found
    case some
      fork test
        hook test
          call check-password
            bind input, read creds/password
            bind hash, read value/password-hash
        hook hold
          send back
            make response
              bind status, code 200
              bind body
                call sign-token, read value
    case none
      send back
        call refuse
  send back
    call refuse
```

## Registration with password hashing

Hash the password before storing it. Reject a duplicate email with `409`. The hash is the app's own task. A password hash wants a slow, salted function (scrypt, argon2), which the standard library does not provide, so it is a native call from the app.

```tree
load @term/site/code/http/http
  find request
  find response

load @term/base/code/maybe
  find maybe

form registration
  link name, like text
  link email, like text
  link password, like text

# the app's own tasks
task parse-registration
  take body, like text
  like registration

task is-registered
  take email, like text
  like boolean

task hash-password
  take input, like text
  like text

task store-user
  take name, like text
  take email, like text
  take password-hash, like text
  like text

task register
  take request, like request
  take params, like hash
  like response
  save body
    call parse-registration
      read request/body
  fork test
    hook test
      call is-registered
        read body/email
    hook hold
      send back
        make response
          bind status, code 409
          bind body, text <email already registered>
  save id
    call store-user
      bind name, read body/name
      bind email, read body/email
      bind password-hash
        call hash-password
          read body/password
  send back
    make response
      bind status, code 201
      bind body, read id
```

## Verifying on a protected route

Check the token's signature, and reject if it does not verify. With no request headers, the token arrives in the body here.

```tree
load @term/site/code/http/http
  find request
  find response

load @term/base/code/cryptography/hmac
  find verify-hmac
  find hmac-algorithm

# the app's own tasks
task signing-key
  like bytes

task token-payload
  take token, like text
  like bytes

task token-tag
  take token, like text
  like bytes

task me
  take request, like request
  take params, like hash
  like response
  note async
  save valid
    call verify-hmac
      bind key
        call signing-key
      bind data
        call token-payload, read request/body
      bind tag
        call token-tag, read request/body
      bind algorithm
        make sha-256
      wait true
  fork test
    hook test
      read valid
    hook hold
      send back
        make response
          bind status, code 200
          bind body, text <signed in>
  send back
    make response
      bind status, code 401
      bind body, text <not signed in>
```

## Sessions

For server-rendered pages, store a session and give its id to the client on login. On each request, load the session by its id and check it. A page that needs a user shows the login page when the session is absent, which is a branch in your own `route` task (see [navigation](navigation.md)). A cookie cannot be set or read yet, because neither a request nor a response carries headers.

## OAuth

An OAuth callback is a normal route. Exchange the code for a token with `post` from `@term/base/code/network/http`, fetch the profile with `fetch`, find or create the user, then issue your own token.

```tree
load @term/base/code/network/http
  find fetch
  find post

task exchange-code
  take code, like text
  take secret, like text
  like text
  note async
  save answer
    call post
      text <https://oauth2.googleapis.com/token>
      text <code={{code}}&client_secret={{secret}}&grant_type=authorization_code>
      wait true
  send back, read answer/body

task fetch-profile
  take access, like text
  like text
  note async
  save header
    make hash
  call header/set
    text <authorization>
    text <Bearer {{access}}>
  save answer
    call fetch
      text <https://openidconnect.googleapis.com/v1/userinfo>
      read header
      wait true
  send back, read answer/body
```

## Token refresh and revocation

Issue a new access token from a valid refresh token, checking a revocation list first. On logout, add the token to that list. The flow is the same shape: parse the token, verify it, check it is not revoked, then mint or revoke.

## Guards on the client

For client page routes, a guard is a branch in your own `route` task that picks the login page when the user is not allowed. See [navigation](navigation.md) for the guard and [routes](routes.md) for the route table.
