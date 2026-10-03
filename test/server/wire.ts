// The language server over its real wire: a child process speaking Content-Length framed JSON-RPC on stdio, exactly
// as an editor starts it. What only the process can show: framing of non-ASCII bodies (the header counts BYTES), a
// malformed request answered with an error rather than a dead process, a cancelled request, and a clean exit.
//
// Run twice: the source entry (deck/flow/code/main.ts under tsx), and the bundle the extension ships
// (deck/flow/make/server.js under plain node, with no node_modules reachable from it), when it has been built with
// `node build.mjs` in deck/flow. The bundle is the one an editor runs, and a module that cannot load inside it
// fails here and nowhere else.
// Run: npx tsx test/server/wire.ts

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

type Message = {
  jsonrpc: '2.0'
  id?: number | string
  method?: string
  params?: unknown
  result?: unknown
  error?: { code: number; message: string }
}

async function session(label: string, command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] })

  let stderr = ''
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8')
  })

  let exited: number | null | undefined
  const exit = new Promise<number | null>(resolve => {
    child.on('exit', code => {
      exited = code
      resolve(code)
    })
  })

  // a byte-accurate reader for the test's side, so the test cannot share the bug it is looking for
  let buffer = Buffer.alloc(0)
  const received: Message[] = []
  const waiters: { want: (m: Message) => boolean; done: (m: Message) => void }[] = []

  child.stdout.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk])

    for (;;) {
      const end = buffer.indexOf('\r\n\r\n')

      if (end < 0) {
        break
      }

      const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString('ascii'))?.[1])

      if (buffer.length < end + 4 + length) {
        break
      }

      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString('utf8')) as Message
      buffer = buffer.subarray(end + 4 + length)
      received.push(message)

      for (const waiter of [...waiters]) {
        if (waiter.want(message)) {
          waiters.splice(waiters.indexOf(waiter), 1)
          waiter.done(message)
        }
      }
    }
  })

  const frame = (message: Message): Buffer => {
    const body = Buffer.from(JSON.stringify(message), 'utf8')

    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
  }

  // every message in ONE write, so the server has to find the boundary between them itself
  const send = (...messages: Message[]): void => {
    child.stdin.write(Buffer.concat(messages.map(frame)))
  }

  const wait = (want: (m: Message) => boolean, ms = 60000): Promise<Message | undefined> => {
    const seen = received.find(want)

    if (seen) {
      return Promise.resolve(seen)
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(undefined), ms)
      waiters.push({
        want,
        done: m => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  const response = (id: number) => (m: Message) => m.id === id && m.method === undefined

  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { capabilities: {} } })
  const init = await wait(response(1))
  ok(
    `${label}: initialize answered over the wire`,
    !!(init?.result as { capabilities?: unknown })?.capabilities,
    `exited ${exited} ${stderr.slice(0, 600)}`,
  )
  send({ jsonrpc: '2.0', method: 'initialized', params: {} })

  // a document holding Greek, CJK and an emoji, and a request in the SAME write. The header counts bytes; a reader
  // that counts characters reads past the first body into the second message and loses it.
  const uri = pathToFileURL(join(process.cwd(), 'tmp/wire-probe.tree')).href
  const text = 'task greet\n  like text\n  send back, text <λόγος 漢字 😀>\n'

  send(
    { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text } } },
    { jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } },
  )

  const symbols = await wait(response(2))
  ok(
    `${label}: framing, a non-ASCII body does not swallow the message after it`,
    Array.isArray(symbols?.result) && (symbols!.result as { name: string }[]).some(s => s.name === 'greet'),
    `${JSON.stringify(symbols)} exited ${exited} ${stderr.slice(0, 300)}`,
  )

  // a request whose params are not what the method takes: answered with an error, and the process lives on
  send({ jsonrpc: '2.0', id: 3, method: 'textDocument/hover', params: null })
  const broken = await wait(response(3), 20000)
  ok(`${label}: malformed request answered (not dropped)`, broken !== undefined, `exited ${exited}, stderr ${stderr.slice(-400)}`)
  ok(`${label}: malformed request answered InvalidParams`, broken?.error?.code === -32602, JSON.stringify(broken))

  send({ jsonrpc: '2.0', id: 4, method: 'textDocument/documentSymbol', params: { textDocument: { uri } } })
  const after = await wait(response(4), 20000)
  ok(`${label}: after a malformed request the server still answers`, after !== undefined, `exited ${exited}`)

  // a request cancelled before it is reached is answered RequestCancelled (-32800)
  send(
    { jsonrpc: '2.0', id: 5, method: 'textDocument/hover', params: { textDocument: { uri }, position: { line: 2, character: 20 } } },
    { jsonrpc: '2.0', method: '$/cancelRequest', params: { id: 5 } },
  )
  const cancelled = await wait(response(5), 20000)
  ok(`${label}: a cancelled request answers -32800`, cancelled?.error?.code === -32800, JSON.stringify(cancelled))

  send({ jsonrpc: '2.0', id: 6, method: 'shutdown' })
  await wait(response(6), 20000)
  send({ jsonrpc: '2.0', method: 'exit' })

  const code = await Promise.race([exit, new Promise<string>(r => setTimeout(() => r('timeout'), 20000))])
  ok(`${label}: exit after shutdown is code 0`, code === 0, String(code))

  if (exited === undefined) {
    child.kill()
  }
}

await session('source', 'npx', ['tsx', join(process.cwd(), 'deck/flow/code/main.ts')], process.cwd())

const bundle = join(process.cwd(), 'deck/flow/make/server.js')

if (existsSync(bundle)) {
  // started from the bundle's own folder, so nothing in the term workspace's node_modules is on its path by accident
  await session('bundle', process.execPath, [bundle], join(process.cwd(), 'deck/flow/make'))
} else {
  console.log('skip  bundle: deck/flow/make/server.js is not built (node build.mjs in deck/flow)')
}

console.log(`\nserver/wire: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
