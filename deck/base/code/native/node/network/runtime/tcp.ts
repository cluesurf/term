// TCP runtime over node:net (plain) and node:tls (secure). Total functions wrapping the platform socket: connect /
// listen / accept / read / write / close. Each returns a promise, so the public async TCP API awaits it. The opaque
// handle a seed `connection` / `listener` holds is the raw node Socket / Server. Reached only through the public TCP API.
import {
  createConnection,
  createServer,
  type Socket,
  type Server,
} from 'node:net'
import {
  connect as tlsConnect,
  createServer as tlsCreateServer,
} from 'node:tls'

// each listening server's connections not yet accepted, and the accepts still waiting for one
const queues = new WeakMap<Server, { waiting: Socket[]; takers: ((socket: Socket) => void)[] }>()

const tcp = {
  connect: (
    host: string,
    port: number,
    secure: boolean,
  ): Promise<Socket> =>
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
      // every connection is queued from the moment the server listens, so one that arrives before `accept` is asked
      // for is not lost: a client's connect resolves only once the connection exists, and the `connection` event had
      // often fired by then, leaving accept waiting for good. Rust and the others accept from the OS backlog
      const waiting: Socket[] = []
      const takers: ((socket: Socket) => void)[] = []
      server.on('connection', socket => {
        const taker = takers.shift()

        if (taker) {
          taker(socket as Socket)
        } else {
          waiting.push(socket as Socket)
        }
      })
      queues.set(server, { waiting, takers })
      server.listen(port, host, () => ok(server))
    }),

  accept: (server: Server): Promise<Socket> =>
    new Promise(ok => {
      const queue = queues.get(server)
      const ready = queue?.waiting.shift()

      if (ready) {
        ok(ready)
      } else if (queue) {
        queue.takers.push(ok)
      } else {
        server.once('connection', socket => ok(socket as Socket))
      }
    }),

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
    new Promise(ok =>
      socket.write(data, () => ok(Buffer.byteLength(data))),
    ),

  close: (socket: Socket): Promise<void> =>
    new Promise(ok => socket.end(() => ok())),

  // stop listening and release the port, then answer: connections already made carry on, as on the other backends.
  // Waiting for node's close callback waited for every open connection to end, so a listener with a client that never
  // hung up never answered
  closeServer: (server: Server): Promise<void> =>
    new Promise(ok => {
      server.close()
      setImmediate(ok)
    }),
}
