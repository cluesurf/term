// UDP runtime over node:dgram. The opaque handle a seed socket holds is the raw dgram Socket. Each call returns a
// promise, so the public async UDP API awaits it. `receive` resolves with the datagram payload and its sender address,
// matching the seed `datagram` form. Reached only through the public UDP API.
import { createSocket, type Socket } from 'node:dgram'

const udp = {
  open: (port: number, host: string): Promise<Socket> =>
    new Promise((ok, fail) => {
      const socket = createSocket('udp4')
      socket.on('error', fail)
      socket.bind(port, host, () => ok(socket))
    }),

  send: (
    socket: Socket,
    data: string,
    host: string,
    port: number,
  ): Promise<number> =>
    new Promise((ok, fail) => {
      const bytes = Buffer.from(data, 'utf8')
      socket.send(bytes, port, host, error =>
        error ? fail(error) : ok(bytes.length),
      )
    }),

  receive: (
    socket: Socket,
  ): Promise<{ data: string; host: string; port: number }> =>
    new Promise(ok =>
      socket.once('message', (message, sender) =>
        ok({
          data: message.toString('utf8'),
          host: sender.address,
          port: sender.port,
        }),
      ),
    ),

  close: (socket: Socket): Promise<void> =>
    new Promise(ok => socket.close(() => ok())),
}
