// WebSocket client runtime over node's global WebSocket (the browser-style API, stable since node 22). The opaque handle
// a seed socket holds is a small wrapper that buffers incoming frames: a permanent listener attached at connect time
// queues every message (and the close), and receive pulls the next one or waits. This makes the request / response
// pattern (send then receive) race-free, since a frame arriving before receive is called is held, not dropped. Reached
// only through the public WebSocket API.
type WebSocketFrame = { kind: string; data: string }
type WebSocketHandle = {
  socket: WebSocket
  queue: WebSocketFrame[]
  waiters: ((frame: WebSocketFrame) => void)[]
}

const websocket = {
  connect: (url: string): Promise<WebSocketHandle> =>
    new Promise((ok, fail) => {
      const socket = new WebSocket(url)
      const handle: WebSocketHandle = { socket, queue: [], waiters: [] }
      const deliver = (frame: WebSocketFrame) => {
        const waiter = handle.waiters.shift()
        if (waiter) waiter(frame)
        else handle.queue.push(frame)
      }
      socket.addEventListener('message', event =>
        deliver({ kind: 'text', data: String(event.data) }),
      )
      socket.addEventListener('close', () =>
        deliver({ kind: 'close', data: '' }),
      )
      socket.addEventListener('open', () => ok(handle))
      socket.addEventListener('error', () =>
        fail(new Error('websocket connect failed')),
      )
    }),

  send: (handle: WebSocketHandle, data: string): Promise<void> => {
    handle.socket.send(data)
    return Promise.resolve()
  },

  receive: (handle: WebSocketHandle): Promise<WebSocketFrame> =>
    new Promise(ok => {
      const frame = handle.queue.shift()
      if (frame) ok(frame)
      else handle.waiters.push(ok)
    }),

  close: (handle: WebSocketHandle): Promise<void> => {
    handle.socket.close()
    return Promise.resolve()
  },
}
