# Channels

A channel is a realtime connection: a WebSocket (or server-sent events) that stays open so the server can push messages. A channel is a [route](routes.md) whose handlers are the connection lifecycle, not HTTP methods: `connect`, `read`, and `close`. Inside them you join rooms, broadcast messages, and track presence.

Maps to: a Socket.IO or Phoenix Channels server, expressed as lifecycle tasks on a `dock` path.

## Cheatsheet

| Form | Job |
| --- | --- |
| `dock /ws/<path>` | Declare a channel at a path |
| `task connect` | A client opened the connection |
| `task read` | A message arrived from the client |
| `task close` | The connection closed |
| `take query` | Read connection query params (room, token) |
| `take body` | The incoming message payload |
| `call broadcast` | Send to every subscriber of a channel |
| `call broadcast-to-room` | Send to one room |
| `call join-room` / `call leave-room` | Room membership |

The lifecycle verbs are handler tasks. The broadcast and room verbs are library tasks the channel calls.

## A basic channel

```tree
dock /ws/chat
  task connect
    take query
      take token
        like text
    call check-token, read token
  task read
    take body, like text
    call broadcast
      bind channel, text <chat>
      bind event, text <message>
      bind data, read body
  task close
    call note-departed
```

- `connect` runs once when a client opens the socket. Reject by returning an error.
- `read` runs for each message the client sends. Here it rebroadcasts the message to every subscriber.
- `close` runs when the socket closes.

## Authenticating on connect

Verify a token at connect time and refuse the connection on failure. This is the same `verify-jwt` flow as [auth](auth.md), applied to the `connect` handler.

```tree
dock /ws/private
  task connect
    take query
      take token
        like text
    save payload
      call verify-jwt
        bind token, read token
    fork test
      hook test
        call is-none, read payload
      hook hold
        bust unauthorized
          bind text, text <not authorized>
```

## Rooms

A dynamic segment in the path scopes the channel to a room. Join on connect, broadcast to that room on each message, and leave on close.

```tree
dock /ws/rooms/:room
  task connect
    take path
      take room
        like text
    call join-room
      bind room, read room
    call broadcast-to-room
      bind room, read room
      bind event, text <user-joined>
  task read
    take body, like text
    take path
      take room
        like text
    call broadcast-to-room
      bind room, read room
      bind event, text <message>
      bind data, read body
  task close
    take path
      take room
        like text
    call leave-room
      bind room, read room
```

## Broadcasting

`broadcast` sends to every subscriber of a channel. `broadcast-to-room` sends to one room. Both take an `event` name and a `data` payload, so the client can switch on the event. Pass an `exclude` to skip the sender when echoing a message.

## On the client

A [zone](components.md) opens the socket, holds the latest messages in a [signal](state.md), and renders them with `walk list`. An incoming message writes the signal, and the reactive list patches in place. Sending a message writes to the socket from an event handler. See [state](state.md) for the signal and list patterns and [fetch](fetch.md) for the request-response counterpart.
