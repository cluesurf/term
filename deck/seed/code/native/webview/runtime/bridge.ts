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
  onReply: ((message: Reply) => void) | null
}

declare global {
  interface Window {
    term?: TermBridge
  }
}

const pending = new Map<string, Pending>()

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
    waiting.reject(message.exception)
  } else {
    waiting.resolve(message.value)
  }
}

// a line for the cask's own log. Fire and forget: `cask_log` is always allowed and answers nothing worth waiting for
function log(text: string): void {
  const term = window.term
  if (term) {
    term.post(JSON.stringify({ id: '', command: 'cask_log', arguments: { text } }))
  }
}

let installed = false

function install(): TermBridge {
  const term = window.term
  if (!term) {
    throw new Error('This page is not inside a cask: window.term is missing')
  }
  if (!installed) {
    installed = true
    term.onReply = settle
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

export const bridge = {
  log,

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
