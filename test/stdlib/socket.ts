// Socket tests: a Seed TCP client and a Seed UDP socket talking to real node echo servers, compiled from base.tree and
// run. Proves the `network/tcp` (connect / write / read / close) and `network/udp` (open / send / receive / close)
// modules work end to end over the wire, delegating to the node net / dgram runtime shims. Run: npx tsx test/stdlib/socket.ts

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as net from 'node:net'
import * as dgram from 'node:dgram'
import { compile } from '@term/make/code/compile/compile'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { render } from '@term/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'seed')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const prefix = '@cluesurf/seed/'
  path = path.replace(/^@term\/seed\//, prefix)

  if (!path.startsWith(prefix)) {
    return undefined
  }

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

let pass = 0
let fail = 0

function eq(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

async function loadModule(
  source: string,
): Promise<Record<string, (...a: any[]) => any>> {
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve: withNativeEnv('node', stdlib) },
  )

  if (!result.ok) {
    for (const d of result.diagnostics) {
      console.log(render(d, source.split('\n'), false))
    }

    throw new Error('compile failed')
  }

  const ts =
    nativePrelude(result.program, 'node', readRuntime) +
    '\n' +
    result.typescript
  const dir = mkdtempSync(join(tmpdir(), 'seed-socket-'))
  const file = join(dir, 'm.ts')
  writeFileSync(file, ts)

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: any[]) => any
  >
}

const TCP = `load @cluesurf/seed/code/network/tcp
  find connect

task ping
  note async
  take host, like text
  take port, like number
  take message, like text
  like text
  save conn
    call connect
      read host
      read port
      false
      wait true
  call write
    read conn
    read message
    wait true
  save reply
    call read
      read conn
      wait true
  call close
    read conn
    wait true
  send back
    read reply
`

const UDP = `load @cluesurf/seed/code/network/udp
  find open

task round-trip
  note async
  take host, like text
  take port, like number
  take message, like text
  like text
  save sock
    call open
      code 0
      text <0.0.0.0>
      wait true
  call send
    read sock
    read message
    read host
    read port
    wait true
  save reply
    call receive
      read sock
      wait true
  call close
    read sock
    wait true
  send back
    read reply/data
`

async function main(): Promise<void> {
  // a node TCP echo server
  const tcpServer = net.createServer(s => s.on('data', d => s.write(d)))
  await new Promise<void>(r => tcpServer.listen(8753, '127.0.0.1', r))

  // a node UDP echo server (sends each datagram back to its sender)
  const udpServer = dgram.createSocket('udp4')
  udpServer.on('message', (msg, rinfo) =>
    udpServer.send(msg, rinfo.port, rinfo.address),
  )
  await new Promise<void>(r => udpServer.bind(8754, '127.0.0.1', r))

  try {
    const tcp = await loadModule(TCP)
    eq(
      'tcp connect/write/read round-trip',
      await tcp.ping('127.0.0.1', 8753, 'ping-from-seed'),
      'ping-from-seed',
    )

    const udp = await loadModule(UDP)
    eq(
      'udp open/send/receive round-trip',
      await udp.roundTrip('127.0.0.1', 8754, 'hi-over-udp'),
      'hi-over-udp',
    )
  } finally {
    tcpServer.close()
    udpServer.close()
  }

  console.log(`\nsockets: ${pass} pass, ${fail} fail`)
}

main()
