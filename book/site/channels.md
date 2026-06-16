# Channels (`seed channel`)

Define real-time WebSocket and SSE channels. Channels handle
connection lifecycle, message routing, presence tracking, and room
management. Use `seed channel` for configuration and `task` blocks
for event handlers.

## Basic Channel

```tree
seed channel, name chat
  seed path, text </ws/chat>

  task join
    take user, like hash
      link id, like text
      link name, like text
    send back, wave true

  task send
    take message, like hash
      link text, like text
      link from, like text
    call broadcast
      bind channel, text <chat>
      bind event, text <message>
      bind data, read message

  task leave
    take user, like hash
      link id, like text
    call broadcast
      bind channel, text <chat>
      bind event, text <user-left>
      bind data
        make event
          bind user-id, read user/id
```

## Authenticated Channel

Require authentication before joining. Use `seed auth` to enforce
token validation on connection.

```tree
seed channel, name private
  seed path, text </ws/private>
  seed auth, wave true

  task join
    take user, like hash
      link id, like text
      link token, like text

    save payload
      call verify-jwt
        bind token, read user/token
        halt kink

    save allowed
      call check-channel-access
        bind user-id, read payload/sub
        bind channel, text <private>

    fork test
      hook test
        call negate
          bind value, read allowed
      hook hold
        halt kink
          make kink
            bind code, text <forbidden>
            bind text, text <not authorized for this channel>

    send back, wave true
```

## Room-Based Channels

Create dynamic rooms within a channel. Users join specific rooms
by ID.

```tree
seed channel, name rooms
  seed path, text </ws/rooms/:room>
  seed auth, wave true

  task join
    take user, like hash
      link id, like text
    take room, like text

    call add-user-to-room
      bind room-id, read room
      bind user-id, read user/id

    call broadcast-to-room
      bind room, read room
      bind event, text <user-joined>
      bind data
        make event
          bind user-id, read user/id
      bind exclude, read user/id

    send back, wave true

  task send
    take message, like hash
      link text, like text
      link from, like text
    take room, like text

    call broadcast-to-room
      bind room, read room
      bind event, text <message>
      bind data, read message

  task leave
    take user, like hash
      link id, like text
    take room, like text

    call remove-user-from-room
      bind room-id, read room
      bind user-id, read user/id

    call broadcast-to-room
      bind room, read room
      bind event, text <user-left>
      bind data
        make event
          bind user-id, read user/id
```

## Presence Tracking

Track which users are online in a channel. Use `task join` and
`task leave` to update presence state.

```tree
seed channel, name presence
  seed path, text </ws/presence>
  seed auth, wave true
  seed presence, wave true

  task join
    take user, like hash
      link id, like text
      link name, like text
      link status, like text

    call set-presence
      bind channel, text <presence>
      bind user-id, read user/id
      bind data
        make presence-data
          bind name, read user/name
          bind status, read user/status

    save members
      call get-presence-list
        bind channel, text <presence>

    call send-to-user
      bind user-id, read user/id
      bind event, text <presence-state>
      bind data, read members

    call broadcast
      bind channel, text <presence>
      bind event, text <presence-join>
      bind data
        make event
          bind user-id, read user/id
          bind name, read user/name
          bind status, read user/status
      bind exclude, read user/id

    send back, wave true

  task send
    take message, like hash
      link type, like text
      link data, like hash
    take user, like hash
      link id, like text

    fork case, read message/type
      case status-update
        call set-presence
          bind channel, text <presence>
          bind user-id, read user/id
          bind data, read message/data
        call broadcast
          bind channel, text <presence>
          bind event, text <presence-update>
          bind data
            make event
              bind user-id, read user/id
              bind status, read message/data/status

  task leave
    take user, like hash
      link id, like text

    call clear-presence
      bind channel, text <presence>
      bind user-id, read user/id

    call broadcast
      bind channel, text <presence>
      bind event, text <presence-leave>
      bind data
        make event
          bind user-id, read user/id
```

## Message Types

Handle different message types with `fork case` on the message
type field.

```tree
seed channel, name chat-typed
  seed path, text </ws/chat>

  task send
    take message, like hash
      link type, like text
      link data, like hash
    take user, like hash
      link id, like text

    fork case, read message/type
      case text
        call broadcast
          bind channel, text <chat-typed>
          bind event, text <message>
          bind data
            make chat-message
              bind type, text <text>
              bind text, read message/data/text
              bind from, read user/id
              bind time, call now
      case image
        call broadcast
          bind channel, text <chat-typed>
          bind event, text <message>
          bind data
            make chat-message
              bind type, text <image>
              bind url, read message/data/url
              bind from, read user/id
              bind time, call now
      case typing
        call broadcast
          bind channel, text <chat-typed>
          bind event, text <typing>
          bind data
            make typing-event
              bind user-id, read user/id
              bind active, read message/data/active
          bind exclude, read user/id
```

## Server-Sent Events (SSE)

Use `seed transport, text <sse>` for one-way server-to-client
streaming.

```tree
seed channel, name notifications
  seed path, text </sse/notifications>
  seed transport, text <sse>
  seed auth, wave true

  task join
    take user, like hash
      link id, like text

    save unread
      call find-unread-notifications
        bind user-id, read user/id

    call send-to-user
      bind user-id, read user/id
      bind event, text <initial>
      bind data, read unread

    send back, wave true
```

Push events to SSE clients from other parts of the application:

```tree
task notify-user
  take user-id, like text
  take message, like text
  take kind, like text

  save notification
    call make-notification
      bind user-id, read user-id
      bind message, read message
      bind kind, read kind

  call send-to-user
    bind user-id, read user-id
    bind event, text <notification>
    bind data, read notification
```

## Channel Middleware

Run middleware on every message or connection event.

```tree
seed channel, name moderated
  seed path, text </ws/moderated>
  seed auth, wave true

  hook boot
    call log-channel-event
    call check-ban-list

  task send
    take message, like hash
      link text, like text
    take user, like hash
      link id, like text

    save clean
      call filter-profanity
        bind text, read message/text

    save allowed
      call check-rate-limit
        bind user-id, read user/id
        bind channel, text <moderated>

    fork test
      hook test
        call negate
          bind value, read allowed
      hook hold
        call send-to-user
          bind user-id, read user/id
          bind event, text <error>
          bind data
            make error
              bind text, text <rate limit exceeded>
        send back

    call broadcast
      bind channel, text <moderated>
      bind event, text <message>
      bind data
        make chat-message
          bind text, read clean
          bind from, read user/id
          bind time, call now
```

## Full Example

A complete chat application with rooms, presence, typing indicators,
and message history.

```tree
seed channel, name app-chat
  seed path, text </ws/chat/:room>
  seed auth, wave true
  seed presence, wave true

  task join
    take user, like hash
      link id, like text
      link name, like text
    take room, like text

    call add-user-to-room
      bind room-id, read room
      bind user-id, read user/id

    save history
      call find-recent-messages
        bind room-id, read room
        bind limit, mark 50

    call send-to-user
      bind user-id, read user/id
      bind event, text <history>
      bind data, read history

    call set-presence
      bind channel, text <app-chat>
      bind user-id, read user/id
      bind data
        make presence-data
          bind name, read user/name
          bind room, read room

    call broadcast-to-room
      bind room, read room
      bind event, text <user-joined>
      bind data
        make event
          bind user-id, read user/id
          bind name, read user/name
      bind exclude, read user/id

    send back, wave true

  task send
    take message, like hash
      link type, like text
      link data, like hash
    take user, like hash
      link id, like text
      link name, like text
    take room, like text

    fork case, read message/type
      case text
        save saved
          call save-message
            bind room-id, read room
            bind user-id, read user/id
            bind text, read message/data/text

        call broadcast-to-room
          bind room, read room
          bind event, text <message>
          bind data
            make chat-message
              bind id, read saved/id
              bind text, read message/data/text
              bind from
                make sender
                  bind id, read user/id
                  bind name, read user/name
              bind time, read saved/time

      case typing
        call broadcast-to-room
          bind room, read room
          bind event, text <typing>
          bind data
            make typing-event
              bind user-id, read user/id
              bind name, read user/name
              bind active, read message/data/active
          bind exclude, read user/id

  task leave
    take user, like hash
      link id, like text
    take room, like text

    call remove-user-from-room
      bind room-id, read room
      bind user-id, read user/id

    call clear-presence
      bind channel, text <app-chat>
      bind user-id, read user/id

    call broadcast-to-room
      bind room, read room
      bind event, text <user-left>
      bind data
        make event
          bind user-id, read user/id
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Channel definition | `seed channel, name x` | `seed channel, name chat` |
| Channel path | `seed path` | `seed path, text </ws/chat>` |
| Authentication | `seed auth` | `seed auth, wave true` |
| Join handler | `task join` | connection lifecycle |
| Send handler | `task send` | message processing |
| Leave handler | `task leave` | disconnection cleanup |
| Broadcast | `call broadcast` | `bind channel, text <chat>` |
| Room broadcast | `call broadcast-to-room` | `bind room, read room` |
| Send to user | `call send-to-user` | `bind user-id, read id` |
| Presence tracking | `seed presence` | `seed presence, wave true` |
| Set presence | `call set-presence` | user online state |
| Clear presence | `call clear-presence` | user offline |
| Presence list | `call get-presence-list` | current members |
| SSE transport | `seed transport` | `seed transport, text <sse>` |
| Room parameter | `:room` in path | `seed path, text </ws/chat/:room>` |
| Exclude sender | `bind exclude` | `bind exclude, read user/id` |
| Channel middleware | `hook boot` | `call check-ban-list` |
| Message types | `fork case, read type` | `case text`, `case typing` |
