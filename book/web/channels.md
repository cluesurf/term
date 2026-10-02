# Channels

A channel is a realtime connection: a WebSocket that stays open so either side can push messages. The standard library has the **client** half, in `@term/base/code/network/websocket`: `connect` opens a socket, and the socket's `send`, `receive` and `close` tasks talk over it. Every one is async.

**There is no server half yet.** `@term/site` has no channel route: no `connect` / `read` / `close` handler tasks on a path, no rooms, no broadcast, no presence. An earlier version of this page described a `dock /ws/...` route with those handlers. `dock` is the native binding now, and none of it compiles. A server that accepts WebSockets is a native call from the app for now.

Maps to: the browser `WebSocket` (or a WebSocket client library), with the platform connection behind one API on every backend.

## Cheatsheet

| Form | Job |
| --- | --- |
| `call connect` with a `ws://` or `wss://` URL | Open a connection, answering a `socket` |
| `call peer/send` on a socket `peer` | Send a text message |
| `call peer/receive` | Wait for the next message, a `message` with `kind` and `data` |
| `call peer/close` | Close the connection |
| `read message/kind` | `text` for a message, `close` when the peer closed |

**The two samples below are fenced as sketches and are not built.** The socket's methods declare `take self` with no type in `websocket.tree`, so `call peer/send` does not receive `peer` and fails as a wrong argument count, and passing `peer` by hand compiles to a call on the record that fails at run time. They show the intended shape until the method declarations are fixed.

## A basic client

```tree fragment
load @term/base/code/network/websocket
  find connect
  find socket
  find message

# send one line and answer the first reply
task ask
  take url, like text
  take line, like text
  like text
  note async
  save peer
    call connect
      read url
      wait true
  call peer/send
    read line
    wait true
  save reply
    call peer/receive
      wait true
  call peer/close
    wait true
  send back, read reply/data
```

`receive` answers a `message` whose `kind` is `text` for a frame and `close` when the peer closed, with an empty `data`.

## Reading until close

Loop on `receive` until the peer closes, handing each message on.

```tree fragment
load @term/base/code/network/websocket
  find connect
  find socket
  find message

task listen
  take url, like text
  take on-message
    like task
      take data, like text
  note async
  save peer
    call connect
      read url
      wait true
  walk test
    hook test
      true
    hook hold
      save next
        call peer/receive
          wait true
      fork test
        hook test
          call is-equal
            read next/kind
            text <close>
        hook hold
          halt
      call on-message
        read next/data
```

## Authenticating on connect

With no headers on the client either, a token goes in the URL's query, `wss://example.com/ws?token=...`, and the server checks it before it accepts. This is the same signed-token check as [auth](auth.md), applied where the server accepts the socket.

## On the client

A [view](components.md) holds the latest messages in a [signal](state.md) and renders them with `walk list`. The loader above writes the signal from `on-message`, and the reactive list patches in place. Sending a message calls the socket's `send` from an event handler. See [state](state.md) for the signal and list patterns and [fetch](fetch.md) for the request-response counterpart.
