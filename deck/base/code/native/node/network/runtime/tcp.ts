// TCP runtime over node:net (plain) and node:tls (secure). Total functions wrapping the platform socket: connect /
// listen / accept / read / write / close. Each returns a promise, so the public async TCP API awaits it. The opaque
// handle a seed `connection` / `listener` holds is the raw node Socket / Server. Reached only through the public TCP API.
import { createConnection, createServer, type Socket, type Server } from 'node:net'
import { connect as tlsConnect, createServer as tlsCreateServer } from 'node:tls'

const tcp = {
  connect: (host: string, port: number, secure: boolean): Promise<Socket> =>
    new Promise((ok, fail) => {
      const socket = secure
        ? tlsConnect({ host, port }, () => ok(socket))
        : createConnection(port, host, () => ok(socket))
      socket.on('error', fail)
    }),

  listen: (
    port: number,
    host: string,
    secure: boolean,
    certificate?: string,
    key?: string,
  ): Promise<Server> =>
    new Promise((ok, fail) => {
      const server =
        secure && certificate && key
          ? tlsCreateServer({ cert: certificate, key })
          : createServer()
      server.on('error', fail)
      server.listen(port, host, () => ok(server))
    }),

  accept: (server: Server): Promise<Socket> =>
    new Promise(ok => server.once('connection', socket => ok(socket as Socket))),

  read: (socket: Socket): Promise<string> =>
    new Promise(ok => {
      const onData = (chunk: Buffer) => {
        socket.off('end', onEnd)
        ok(chunk.toString('utf8'))
      }
      const onEnd = () => {
        socket.off('data', onData)
        ok('')
      }
      socket.once('data', onData)
      socket.once('end', onEnd)
    }),

  write: (socket: Socket, data: string): Promise<number> =>
    new Promise(ok => socket.write(data, () => ok(Buffer.byteLength(data)))),

  close: (socket: Socket): Promise<void> =>
    new Promise(ok => socket.end(() => ok())),

  closeServer: (server: Server): Promise<void> =>
    new Promise(ok => server.close(() => ok())),
}
