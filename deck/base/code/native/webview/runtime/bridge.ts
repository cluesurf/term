// The page side of the cask bridge. The one file in the `webview` env that knows how a page reaches its cask.
//
// A call is `{ id, command, arguments }` posted as text through `window.term.post`, which the cask injected at
// document start. The cask answers on the main thread by calling `window.term.reply(reply)` with `{ id, value }` or
// `{ id, exception }`, and the pending promise with that id settles. Ids are tone codes from a counter, never
// reused within one page. Provided to Term via <global:bridge> (docked `name bridge`), so the object IS the binding
// and a native module calls `bridge.invoke("file_read_file", { path })`.
//
// This is what tauri's `invoke` does with a callback id and an error id registered on `window`
// (land/code/github.com/tauri-apps/tauri/crates/tauri/scripts/ipc.js), with one id and one reply function instead.
// Design: note/term/cask/readme.md.

type Reply = { id: string; value?: unknown; exception?: unknown }

type Pending = { resolve: (value: unknown) => void; reject: (reason: unknown) => void }

type TermBridge = {
  post: (text: string) => void
  reply: (message: Reply) => void
  push: (name: string, text: string) => void
  onReply: ((message: Reply) => void) | null
  onPush: ((name: string, text: string) => void) | null
}

declare global {
  interface Window {
    term?: TermBridge
  }
}

const pending = new Map<string, Pending>()

// what the page listens for, by event name. The cask pushes through `window.term.push(name, text)`
const listeners = new Map<string, ((text: string) => void)[]>()

function pushed(name: string, text: string): void {
  for (const handler of listeners.get(name) ?? []) {
    handler(text)
  }
}

let counter = 0

// the consonant alphabet every id in the house uses, so an id never spells a word
const TONE = 'bcdfghklmnprstvwxz'

function nextId(): string {
  counter += 1
  let n = counter
  const parts: string[] = []
  while (n > 0) {
    parts.push(TONE[n % TONE.length])
    n = Math.floor(n / TONE.length)
  }
  return parts.reverse().join('') || TONE[0]
}

function settle(message: Reply): void {
  const waiting = pending.get(message.id)
  if (!waiting) {
    return
  }
  pending.delete(message.id)
  if (message.exception !== undefined) {
    waiting.reject(exceptionOf(String(message.exception)))
  } else {
    waiting.resolve(message.value)
  }
}

// the cask's exception as the page's own: the carrier the TypeScript backend raises (compile/typescript.ts,
// `TermException`), so a handler reads `error/form` and `error/note` off a refused command as off any raise. The cask
// writes `<form>: <note>` (`out-of-scope: file_read /etc/passwd`), or a bare form (`command-not-allowed`). It was the
// bare text, which a handler read no field of
function exceptionOf(text: string): Error {
  const split = /^([a-z][a-z0-9-]*): ([\s\S]*)$/.exec(text)
  const form = split ? split[1]! : /^[a-z][a-z0-9-]*$/.test(text) ? text : 'failure'
  const note = split ? split[2]! : text

  return Object.assign(new Error(note), { name: 'TermException', host: '', form, note, code: '', time: Date.now(), link: {} })
}

// a line for the cask's own log. Fire and forget: `cask_log` is always allowed and answers nothing worth waiting for
function log(text: string): void {
  const term = window.term
  if (term) {
    term.post(JSON.stringify({ id: '', command: 'cask_log', arguments: { text } }))
  }
}

let installed = false

// the Android cask cannot inject `window.term` before the page runs without a library, so it exposes the native
// half as `__term_native` through addJavascriptInterface, and the page builds the same `window.term` over it
type NativeHalf = { post: (text: string) => void }

declare global {
  interface Window {
    __term_native?: NativeHalf
  }
}

function adopt(): TermBridge | undefined {
  const native = window.__term_native
  if (!native) {
    return undefined
  }
  const term: TermBridge = {
    post: text => native.post(String(text)),
    reply: message => term.onReply?.(message),
    push: (name, text) => term.onPush?.(name, text),
    onReply: null,
    onPush: null,
  }
  Object.defineProperty(window, 'term', { value: term })
  return term
}

function install(): TermBridge {
  const term = window.term ?? adopt()
  if (!term) {
    throw new Error('This page is not inside a cask: window.term is missing')
  }
  if (!installed) {
    installed = true
    term.onReply = settle
    term.onPush = pushed
    // a page that throws inside a WebView is invisible from outside it. Every uncaught error and every rejected
    // promise nobody caught goes to the cask's log, where CASK_TRACE and the test runner can read it
    window.addEventListener('error', event => {
      log(`page error: ${event.message} at ${event.filename}:${event.lineno}`)
    })
    window.addEventListener('unhandledrejection', event => {
      const reason = event.reason
      log(`page rejection: ${reason instanceof Error ? `${reason.message}\n${reason.stack ?? ''}` : String(reason)}`)
    })
  }
  return term
}

// Handle lifetime (native-dom-0017). A handle is a value the cask keeps for the page under an id, and the page holds
// the id. When the page lets go of the object carrying an id and the WebView collects it, the cask is told to let go
// too, so a page that queries in a loop for a day does not grow the cask's table for a day. This is Expo's
// SharedObject lifetime (expo-modules-core/common/cpp/SharedObject.cpp: a destructor that deletes the registry entry)
// over a JSON bridge, where FinalizationRegistry is the destructor. Collection is the engine's to schedule, so a
// release may come late and never comes early; `release` lets a page say it at once.
const handles =
  typeof FinalizationRegistry === 'function'
    ? new FinalizationRegistry<{ form: string; handle: string }>(held => {
        const term = window.term
        if (term) {
          term.post(JSON.stringify({ id: '', command: 'cask_release', arguments: held }))
        }
      })
    : undefined

export const bridge = {
  log,

  // register a handle the page just received, so its collection releases it in the cask
  held(form: string, value: object, handle: string): void {
    handles?.register(value, { form, handle }, value)
  },

  // let a handle go now rather than at collection, and stop watching it. A round trip, not a post: the cask answers
  // each message in a task of its own, so a release posted and not waited for could be overtaken by the very next
  // call using the handle, which the cask then answered. Waiting for the cask's reply is what makes "a use after
  // release is refused" true (native-dom-0019 found it, when the dispatcher gained a suspension point)
  release(form: string, value: object, handle: string): Promise<unknown> {
    handles?.unregister(value)
    return bridge.invoke('cask_release', { form, handle })
  },

  // receive every event the cask pushes under `name`
  listen(name: string, handler: (text: string) => void): void {
    install()
    listeners.set(name, [...(listeners.get(name) ?? []), handler])
  },

  // send a command to the cask and wait for its reply. Rejects with the cask's exception carrier when the command
  // raised, or when the cask refused a command its allowlist does not hold
  invoke(command: string, args: unknown): Promise<unknown> {
    const term = install()
    const id = nextId()
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      term.post(JSON.stringify({ id, command, arguments: args }))
    })
  },

  // a command whose reply is text, typed for the natives that return one
  async invokeText(command: string, args: unknown): Promise<string> {
    const value = await bridge.invoke(command, args)
    return typeof value === 'string' ? value : String(value ?? '')
  },

  // a command whose reply is a boolean
  async invokeBoolean(command: string, args: unknown): Promise<boolean> {
    return Boolean(await bridge.invoke(command, args))
  },

  // a command whose reply is an integer
  async invokeNumber(command: string, args: unknown): Promise<number> {
    return Math.trunc(Number(await bridge.invoke(command, args)) || 0)
  },

  // a command whose reply is a decimal
  async invokeDecimal(command: string, args: unknown): Promise<number> {
    return Number(await bridge.invoke(command, args)) || 0
  },

  // a command with no reply worth keeping
  async invokeVoid(command: string, args: unknown): Promise<void> {
    await bridge.invoke(command, args)
  },
}
