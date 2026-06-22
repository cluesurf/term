// WebSocket client runtime over node's global WebSocket (the browser-style API, stable since node 22). The opaque
// handle a seed socket holds is the raw WebSocket. connect resolves once the handshake opens; receive resolves with the
// next message or a close frame, matching the seed `message` form. Reached only through the public WebSocket API.
const websocket = {
  connect: (url: string): Promise<WebSocket> =>
    new Promise((ok, fail) => {
      const socket = new WebSocket(url)
      socket.addEventListener('open', () => ok(socket))
      socket.addEventListener('error', () =>
        fail(new Error('websocket connect failed')),
      )
    }),

  send: (socket: WebSocket, data: string): Promise<void> => {
    socket.send(data)
    return Promise.resolve()
  },

  receive: (
    socket: WebSocket,
  ): Promise<{ kind: string; data: string }> =>
    new Promise(ok => {
      const onMessage = (event: MessageEvent) => {
        cleanup()
        ok({ kind: 'text', data: String(event.data) })
      }
      const onClose = () => {
        cleanup()
        ok({ kind: 'close', data: '' })
      }
      const cleanup = () => {
        socket.removeEventListener('message', onMessage)
        socket.removeEventListener('close', onClose)
      }
      socket.addEventListener('message', onMessage)
      socket.addEventListener('close', onClose)
    }),

  close: (socket: WebSocket): Promise<void> => {
    socket.close()
    return Promise.resolve()
  },
}
