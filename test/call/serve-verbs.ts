// The verbs that START SOMETHING and stay running: `work`, `feed`, and `zone`.
//
// These were the last verbs with no test, and the reason is that each one needs more than an exit code to say
// anything. A server that starts, prints a cheerful line and answers nothing is indistinguishable from a working
// one if all you check is that it did not crash. So each is STARTED, ASKED A REAL QUESTION, and killed.
//
//   `work` hosts the warm incremental compiler over HTTP for the language server, `term feed` and the CLI. It is
//   asked to analyze a file that is WRONG and a file that is RIGHT, and it has to tell them apart. Anything less
//   would pass on a daemon that returned an empty diagnostic list for everything, which is the failure a warm
//   cache is most likely to have.
//
//   `feed` is the dev server. It has to SERVE the scaffolded app, not merely bind a port.
//
//   `zone` is the secret console, and it is a Term app: running it BUILDS `deck/zone/code/line/base.tree` through
//   the compiler and runs the result, so this exercises the whole boot path and not just an argument parser. With
//   no command it prints its commands, and every command it prints has to be one it actually has.
//
// NO PORT IS FIXED. A hard-coded port fails on a machine that happens to be using it, and worse, PASSES against
// whatever else is listening there. Each server is given port 0-style freedom by picking a free one first.
//
// Run: npx tsx test/call/serve-verbs.ts

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 400)}` : ''}`)
  }
}

const box = mkdtempSync(join(tmpdir(), 'term-serve-'))
const home = join(box, 'home')

mkdirSync(home, { recursive: true })

const env = { ...process.env, HOME: home }

spawnSync('node', [LINE, 'wake', 'demo'], { cwd: box, env, timeout: 120000 })

const root = join(box, 'demo')

// a port nothing is listening on, asked of the operating system rather than guessed
function freePort(): Promise<number> {
  return new Promise((done, stop) => {
    const server = createServer()

    server.on('error', stop)
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0

      server.close(() => done(port))
    })
  })
}

// start a verb, wait until it answers, run the checks, kill it. The wait is a POLL rather than a sleep: a fixed
// sleep is either slower than it needs to be or flaky on a loaded machine, and here it would be both.
async function serving<T>(
  argv: string[],
  probe: (port: number) => Promise<T | undefined>,
): Promise<T | undefined> {
  const port = await freePort()
  const child = spawn('node', [LINE, ...argv, '--port', String(port)], {
    cwd: root,
    env,
    stdio: 'ignore',
  })

  try {
    for (let tries = 0; tries < 120; tries++) {
      await new Promise(r => setTimeout(r, 500))

      try {
        const answer = await probe(port)

        if (answer !== undefined) {
          return answer
        }
      } catch {
        // not up yet
      }
    }

    return undefined
  } finally {
    child.kill('SIGKILL')
  }
}

const BROKEN = 'task bad\n  take n, like number\n  like text\n  send back\n    read n\n'
const FINE = 'task fine\n  take n, like number\n  like number\n  send back\n    read n\n'

// ---- work: the warm compiler, and it must actually compile ----

type Analysis = { broken: unknown[]; fine: unknown[] }

const analysis = await serving<Analysis>(['work'], async port => {
  const ask = async (text: string): Promise<unknown[]> => {
    const answer = await fetch(`http://localhost:${port}/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file: 'x.tree', text }),
    })

    const body = (await answer.json()) as { diagnostics?: unknown[] }

    return body.diagnostics ?? []
  }

  return { broken: await ask(BROKEN), fine: await ask(FINE) }
})

ok('`work` starts and answers /analyze', analysis !== undefined)

// BOTH DIRECTIONS. A daemon that reported nothing for everything would pass the first half alone, and an empty
// diagnostic list is exactly what a broken warm cache returns.
ok(
  '`work` reports the defect in a file that has one',
  (analysis?.broken.length ?? 0) === 1,
  JSON.stringify(analysis?.broken).slice(0, 200),
)

ok(
  '`work` reports nothing for a file that is fine',
  (analysis?.fine.length ?? 0) === 0,
  JSON.stringify(analysis?.fine).slice(0, 200),
)

ok(
  'and the defect it reports is the type mismatch, not something else',
  JSON.stringify(analysis?.broken ?? []).includes('type-mismatch'),
  JSON.stringify(analysis?.broken).slice(0, 200),
)

// ---- feed: the dev server, and it must serve ----

const served = await serving<number>(['feed'], async port => {
  const answer = await fetch(`http://localhost:${port}/`)

  return answer.status
})

ok('`feed` starts and serves the scaffolded app', served !== undefined && served < 500, String(served))

// ---- zone: the secret console, which is a Term app ----
//
// With no command it prints its commands. Running it at all compiles deck/zone/code/line/base.tree through the
// compiler and runs the emitted module, so a compile regression anywhere under zone fails here.

const zone = spawnSync('node', [LINE, 'zone'], {
  cwd: root,
  env,
  encoding: 'utf8',
  timeout: 300000,
})
const zoneOut = `${zone.stdout ?? ''}${zone.stderr ?? ''}`

ok('`zone` boots and prints its usage', /usage: term zone/.test(zoneOut), zoneOut)

// every command the usage advertises. A console that lists a command it does not have is worse than one that
// lists none, and this is the list a person reads first.
for (const command of ['bind', 'call', 'code', 'load', 'list', 'save', 'read']) {
  ok(`\`zone\` offers \`${command}\``, new RegExp(`\\b${command}\\b`).test(zoneOut))
}

// ---- cast: build the app into a deployable worker ----
//
// `term cast` is the deploy path: it compiles the app for CLOUDFLARE, which borrows the BROWSER env, and writes a
// worker entry plus a client bundle.
//
// IT DID NOT WORK ON A SCAFFOLDED PROJECT. There was no `native/browser/console.tree` at all, and `console.tree`
// is what `log` and `error` reach, so nothing that printed a line could be built for the browser. A fresh
// project cast with `the name "write-error" is not defined`, pointing into the stdlib rather than at anything the
// person had written. `console` is a real global in a browser and in a Worker alike, so the implementation docks
// it directly the way node's does.

const cast = spawnSync('node', [LINE, 'cast'], {
  cwd: root,
  env,
  encoding: 'utf8',
  timeout: 600000,
})
const castOut = `${cast.stdout ?? ''}${cast.stderr ?? ''}`

ok('`cast` builds the scaffolded app for Cloudflare', /Cast -> work/.test(castOut), castOut)

ok(
  'and writes the worker entry and the client bundle it names',
  existsSync(join(root, 'work/index.ts')) && existsSync(join(root, 'build')),
  castOut,
)

console.log(`\nserve-verbs: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
