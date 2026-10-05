// The device capabilities in a real browser (device-layer): the same contracts as test/compile/device-features.ts,
// compiled for the `browser` env, bundled, served from 127.0.0.1 (a secure origin, which the clipboard and the camera
// need), and run in headless Chrome with a profile of its own, driven over the DevTools protocol with Node's own
// WebSocket, so nothing is installed. Chrome is told what a person's browser would hold: the grants (geolocation, the
// camera, the clipboard, notifications), a position (the Eiffel Tower), and a fake camera, which draws a test pattern.
//
// Each answer is printed with console.log and read from the protocol, and judged against what a desktop Chrome can
// answer. The photo is checked IN the page: its blob is fetched and must be a JPEG of some size. The battery is
// checked against `pmset`, since Chrome reads the Mac's own.
//
// Skipped, with the reason, without Chrome. Run: npx tsx test/compile/device-browser-features.ts
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

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

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

if (!existsSync(CHROME)) {
  console.log(`skip  device-browser-features  (no Chrome at ${CHROME})`)
  console.log('\ndevice-browser-features: 0 pass, 0 fail, 1 skipped')
  process.exit(0)
}

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-device-browser-'))
const TOKEN = `term-clipboard-${process.pid}-${Date.now()}`
const PLACE = { latitude: 48.85837, longitude: 2.294481 }
const TITLE = `Term device ${process.pid}`

// one call: the step it prints under, the contract task, and its text arguments
type Call = [step: string, task: string, args: string[]]

const CALLS: Call[] = [
  ['clipboard-write', 'write-clipboard', [TOKEN]],
  ['clipboard-read', 'read-clipboard', []],
  ['permission-camera', 'permission-status', ['camera']],
  ['permission-location', 'permission-status', ['location']],
  ['permission-notification', 'permission-status', ['notification']],
  ['position', 'current-position', []],
  ['battery', 'battery-status', []],
  ['network', 'network-status', []],
  ['vibrate', 'vibrate', ['medium']],
  ['torch-state', 'torch-state', []],
  ['torch-set', 'set-torch', ['on']],
  ['notification', 'show-notification', [TITLE, 'posted by device-browser-features']],
  ['share', 'share-text', ['shared by device-browser-features']],
  ['motion', 'read-motion', []],
  ['camera', 'take-photo', []],
]

const LOADS = [
  ['clipboard', ['read-clipboard', 'write-clipboard']],
  ['permission', ['permission-status']],
  ['location', ['current-position', 'watch-position']],
  ['battery', ['battery-status', 'watch-battery']],
  ['network', ['network-status', 'watch-network']],
  ['vibration', ['vibrate']],
  ['torch', ['torch-state', 'set-torch']],
  ['notification', ['show-notification']],
  ['open', ['share-text']],
  ['motion', ['read-motion', 'watch-motion']],
  ['camera', ['take-photo']],
] as const

// the watchers the page starts after its calls (device-layer-0016), each saying every answer under its own name. The
// second position watcher shares the first one's subscription and must hear the move too; the dropped one is dropped as
// soon as it is made, and must not
const WATCHERS: [name: string, task: string, dropped: boolean][] = [
  ['position', 'watch-position', false],
  ['position-again', 'watch-position', false],
  ['position-dropped', 'watch-position', true],
  ['battery', 'watch-battery', false],
  ['network', 'watch-network', false],
  ['motion', 'watch-motion', false],
]
// where Chrome's position is moved once the watchers run
const MOVED = { latitude: 48.860611, longitude: 2.337644 }

const PROGRAM = [
  'load @term/base/log',
  '  find info',
  ...LOADS.flatMap(([file, finds]) => ['', `load @term/site/code/view/${file}`, ...finds.map(one => `  find ${one}`)]),
  '',
  'task boot',
  '  mark async',
  '  like void',
  ...CALLS.flatMap(([step, task, args]) => [
    `  save said-${step}`,
    `    call ${task}`,
    ...args.map(arg => `      text <${arg}>`),
    '  call info',
    `    text <step ${step} {said-${step}}>`,
  ]),
  ...WATCHERS.flatMap(([name, task, dropped]) => [
    `  save drop-${name}`,
    `    call ${task}`,
    '      task heard',
    '        take value, like text',
    '        call info',
    `          text <step watch-${name} {value}>`,
    ...(dropped ? [`  call drop-${name}`] : []),
  ]),
  '  call info',
  '    text <step done>',
  '',
].join('\n')

// the program for the browser env: its prelude, its TypeScript and an entry, bundled into one module the page loads
async function buildPage(): Promise<string> {
  const page = join(dir, 'page.tree')
  writeFileSync(page, PROGRAM)
  const result = compile({ file: page, text: PROGRAM }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' })

  if (!result.ok) {
    throw new Error(`the page failed to compile: ${result.diagnostics.slice(0, 3).map(one => one.message).join('; ')}`)
  }

  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, 'browser', readRuntime, result.typescript)
  const work = join(dir, 'work')
  mkdirSync(work, { recursive: true })
  writeFileSync(join(work, 'app.ts'), `${prelude}\n${result.typescript}`)
  writeFileSync(join(work, 'entry.ts'), "import { boot } from './app'\nboot()\n")
  const { build } = await import('esbuild')
  const bundled = await build({ entryPoints: [join(work, 'entry.ts')], bundle: true, format: 'esm', platform: 'browser', write: false })
  const site = join(dir, 'site')
  mkdirSync(site, { recursive: true })
  writeFileSync(join(site, 'app.js'), bundled.outputFiles[0]!.text)
  writeFileSync(join(site, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Term device</title><script type="module" src="./app.js"></script>')

  return site
}

// one DevTools connection: a request is answered by its id, and an event goes to whoever listens for its method
class Protocol {
  private next = 1
  private waiting = new Map<number, (value: { result?: unknown; error?: { message: string } }) => void>()
  private listeners: ((method: string, params: Record<string, unknown>, session?: string) => void)[] = []

  constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: Record<string, unknown>; sessionId?: string; result?: unknown; error?: { message: string } }

      if (message.id !== undefined) {
        this.waiting.get(message.id)?.(message)
        this.waiting.delete(message.id)
      } else if (message.method) {
        for (const listener of this.listeners) listener(message.method, message.params ?? {}, message.sessionId)
      }
    })
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.next++
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))

    return new Promise((resolve, reject) =>
      this.waiting.set(id, answer => (answer.error ? reject(new Error(`${method}: ${answer.error.message}`)) : resolve((answer.result ?? {}) as Record<string, unknown>))),
    )
  }

  on(listener: (method: string, params: Record<string, unknown>, session?: string) => void): void {
    this.listeners.push(listener)
  }
}

const pause = (ms: number) => new Promise(settle => setTimeout(settle, ms))

async function main(): Promise<void> {
  const site = await buildPage()
  ok('the page builds for the browser env', existsSync(join(site, 'app.js')))

  const types: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html' }
  const server = createServer((request, response) => {
    const file = join(site, request.url === '/' ? 'index.html' : (request.url ?? '').slice(1))

    if (!file.startsWith(site) || !existsSync(file)) {
      response.writeHead(404).end()

      return
    }

    response.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file))
  })
  await new Promise<void>(settle => server.listen(0, '127.0.0.1', settle))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  const profile = join(dir, 'profile')
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  try {
    // Chrome writes its port and the browser's path into the profile once it listens
    const portFile = join(profile, 'DevToolsActivePort')
    const deadline = Date.now() + 30_000

    while (!existsSync(portFile) && Date.now() < deadline) await pause(100)

    const [port, path] = readFileSync(portFile, 'utf8').trim().split('\n')
    const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise<void>((settle, refuse) => {
      socket.addEventListener('open', () => settle())
      socket.addEventListener('error', () => refuse(new Error('the DevTools socket did not open')))
    })
    const protocol = new Protocol(socket)

    // what a person's browser would hold for this origin
    await protocol.send('Browser.grantPermissions', {
      origin,
      permissions: ['geolocation', 'videoCapture', 'clipboardReadWrite', 'clipboardSanitizedWrite', 'notifications'],
    })
    const { targetId } = await protocol.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = (await protocol.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
    const lines: string[] = []
    protocol.on((method, params, session) => {
      if (method === 'Runtime.consoleAPICalled' && session === sessionId) {
        const args = (params['args'] as { value?: unknown }[] | undefined) ?? []
        lines.push(args.map(one => String(one.value ?? '')).join(' '))
      }
    })
    await protocol.send('Runtime.enable', {}, sessionId)
    await protocol.send('Page.enable', {}, sessionId)
    await protocol.send('Emulation.setGeolocationOverride', { ...PLACE, accuracy: 5 }, sessionId)
    // the clipboard reads and writes only for a focused page
    await protocol.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId)
    await protocol.send('Page.navigate', { url: `${origin}/` }, sessionId)

    const finished = Date.now() + 60_000

    while (!lines.some(line => line.includes('step done')) && Date.now() < finished) await pause(100)

    const said = (name: string): string => {
      const line = lines.find(one => one.includes(`step ${name} `)) ?? ''

      return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
    }
    ok('the page ran every capability and said it was done', lines.some(line => line.includes('step done')), lines.join(' | ').slice(-800))

    ok('chrome: the clipboard takes a line and gives it back', said('clipboard-write') === 'written' && said('clipboard-read') === TOKEN, `${said('clipboard-write')} ${said('clipboard-read')}`)
    ok('chrome: the grants Chrome was given read granted', ['camera', 'location', 'notification'].every(name => said(`permission-${name}`) === 'granted'), ['camera', 'location', 'notification'].map(name => said(`permission-${name}`)).join(' '))

    const [latitude = '', longitude = ''] = said('position').split(' ')
    ok('chrome: the position is the one Chrome was told', Math.abs(Number(latitude) - PLACE.latitude) < 0.0005 && Math.abs(Number(longitude) - PLACE.longitude) < 0.0005, said('position'))

    const percent = /(\d+)%/.exec(spawnSync('pmset', ['-g', 'batt'], { encoding: 'utf8' }).stdout)?.[1]
    const level = Number(said('battery').split(' ')[0])
    ok(
      "chrome: the battery is the Mac's own, against pmset",
      percent === undefined ? /^\d\.\d\d (charging|full|unplugged)$|^unavailable$/.test(said('battery')) : Math.abs(level * 100 - Number(percent)) <= 1,
      `${said('battery')} against ${percent ?? 'no battery'}%`,
    )
    ok('chrome: the network is online', /^online (wifi|cellular|wired|other)$/.test(said('network')), said('network'))
    ok('chrome: a vibration answers from the closed set', ['played', 'unavailable'].includes(said('vibrate')), said('vibrate'))
    ok("chrome: the fake camera has no torch, said so both ways", said('torch-state') === 'unavailable' && said('torch-set') === 'unavailable', `${said('torch-state')} ${said('torch-set')}`)
    ok('chrome: the notification is shown, with the grant', said('notification') === 'shown', said('notification'))
    ok('chrome: a share no click asked for is refused, or there is none', ['denied', 'unavailable'].includes(said('share')), said('share'))
    ok('chrome: no accelerometer on a desktop, said so', said('motion') === 'unavailable', said('motion'))

    // the photo, checked where its blob lives: in the page
    const photo = said('camera')
    ok('chrome: the camera takes a photo from the fake device', photo.startsWith('photo blob:'), photo)

    if (photo.startsWith('photo blob:')) {
      const { result } = (await protocol.send(
        'Runtime.evaluate',
        { expression: `fetch(${JSON.stringify(photo.slice('photo '.length))}).then(r => r.blob()).then(b => b.type + ' ' + b.size)`, awaitPromise: true, returnByValue: true },
        sessionId,
      )) as { result: { value?: string } }
      const [type = '', size = '0'] = (result.value ?? '').split(' ')
      ok('chrome: and it is a JPEG of some size', type === 'image/jpeg' && Number(size) > 1000, result.value ?? '')
    }

    // the watchers: Chrome is moved, then taken offline and back, as the platform would be, and each watcher must hear
    // it without being asked again
    const heard = (name: string): string[] => {
      const at = `step watch-${name} `

      return lines.filter(one => one.includes(at)).map(one => one.slice(one.indexOf(at) + at.length).trim())
    }
    const until = async (done: () => boolean): Promise<void> => {
      const by = Date.now() + 15_000

      while (!done() && Date.now() < by) await pause(100)
    }
    const near = (said: string, place: { latitude: number; longitude: number }): boolean => {
      const [a = '', b = ''] = said.split(' ')

      return Math.abs(Number(a) - place.latitude) < 0.0005 && Math.abs(Number(b) - place.longitude) < 0.0005
    }

    await until(() => heard('position').length > 0 && heard('network').length > 0 && heard('motion').length > 0)
    await protocol.send('Emulation.setGeolocationOverride', { ...MOVED, accuracy: 5 }, sessionId)
    await until(() => heard('position').some(said => near(said, MOVED)) && heard('position-again').some(said => near(said, MOVED)))
    await protocol.send('Network.enable', {}, sessionId)
    const conditions = { latency: 0, downloadThroughput: -1, uploadThroughput: -1 }
    await protocol.send('Network.emulateNetworkConditions', { offline: true, ...conditions }, sessionId)
    await until(() => heard('network').includes('offline none'))
    await protocol.send('Network.emulateNetworkConditions', { offline: false, ...conditions }, sessionId)
    await until(() => heard('network').at(-1)?.startsWith('online') === true && heard('network').length >= 3)

    ok('chrome: the position watcher hears where it is first', near(heard('position')[0] ?? '', PLACE), heard('position').join(' | '))
    ok('chrome: and then the move, without asking again', heard('position').some(said => near(said, MOVED)), heard('position').join(' | '))
    ok('chrome: a second watcher on the same position hears the move too', heard('position-again').some(said => near(said, MOVED)), heard('position-again').join(' | '))
    ok('chrome: a watcher dropped at once hears nothing after', !heard('position-dropped').some(said => near(said, MOVED)), heard('position-dropped').join(' | '))
    ok(
      'chrome: the network watcher hears online, offline and online again',
      /^online /.test(heard('network')[0] ?? '') && heard('network').includes('offline none') && /^online /.test(heard('network').at(-1) ?? ''),
      heard('network').join(' | '),
    )
    ok('chrome: the battery watcher answers what the read answers', heard('battery')[0] === said('battery'), `${heard('battery').join(' | ')} against ${said('battery')}`)
    ok('chrome: no accelerometer, so the motion watcher says so once', heard('motion').join(' | ') === 'unavailable', heard('motion').join(' | '))

    socket.close()
  } finally {
    // Chrome writes its profile until it has gone, so the folder is removed after it exits, not as it is told to
    await new Promise<void>(settle => {
      const timer = setTimeout(settle, 10_000)
      chrome.once('exit', () => {
        clearTimeout(timer)
        settle()
      })
      chrome.kill()
    })
    server.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }

  console.log(`\ndevice-browser-features: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.log(`FAIL  device-browser-features  ${String(error instanceof Error ? error.message : error).slice(0, 1200)}`)
  console.log(`\ndevice-browser-features: ${pass} pass, ${fail + 1} fail`)
  process.exit(1)
})
