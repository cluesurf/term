// The WebSocket echo peer test/stdlib/websocket.tree holds network/websocket's client against (item
// term-self-host-001-1637, rulings term-self-host-001-1632 (b) and 1640 (c): an outside peer the Term suite talks to,
// so it sits with the oracles). The suite starts it as a child on a port it held a moment ago and let go:
// `node test/oracle/websocket-echo.mjs <port>`. It answers the upgrade (the SHA-1 accept key of RFC 6455), unmasks each
// short client text frame and sends its payload back unmasked, then says `listening <port>` on its output once it
// listens. It ends when its standard input closes or on TERM. @term/base has no SHA-1 and no upgrade hook yet (1048
// area): when it has both, this peer becomes Term.
import * as http from 'node:http'
import * as crypto from 'node:crypto'

const port = Number(process.argv[2])

if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write(`websocket-echo.mjs: no port in ${JSON.stringify(process.argv[2])}\n`)
  process.exit(2)
}

const server = http.createServer()

server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  const accept = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64')

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept +
      '\r\n\r\n',
  )
  socket.on('data', buffer => {
    const length = buffer[1] & 0x7f

    if (length >= 126) {
      return
    }

    const mask = buffer.subarray(2, 6)
    const payload = Buffer.from(buffer.subarray(6, 6 + length))

    for (let at = 0; at < payload.length; at++) {
      payload[at] ^= mask[at % 4]
    }

    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]))
  })
  socket.on('error', () => {})
})

server.on('error', error => {
  process.stderr.write(`websocket-echo.mjs: ${error.message}\n`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`listening ${port}\n`)
})

// the suite's end is this peer's end: a closed standard input, or TERM from `stop`
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
process.on('SIGTERM', () => process.exit(0))
