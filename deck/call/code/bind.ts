// `term bind`: log this machine in to term.surf, so `term host` credits what it publishes to your account.
//
// THE FLOW IS GOOGLE'S, FOR AN INSTALLED APP, the same one `gcloud auth login` and `claude` use:
//
//   1. listen on `http://127.0.0.1:<a free port>/`, nothing else, and only until one answer arrives
//   2. ask term.surf for the Google URL (`/sessions/terminal/create!`), sending the loopback address, a PKCE
//      challenge and a random `state`
//   3. open that URL in the browser, and print it too, for a terminal whose browser cannot be opened
//   4. Google sends the browser back to the loopback address with a code. The `state` must be ours
//   5. post the code and the PKCE verifier to `/sessions/terminal/verify!`, which swaps it with Google and answers
//      with a term.surf token scoped to `package:publish`
//   6. write the token to the user-level `auth` file, the one `term host` already reads
//
// THE GOOGLE CLIENT SECRET NEVER REACHES THIS MACHINE. term.surf holds it and does the swap, so the CLI knows only
// the URL it was handed. PKCE is what keeps the code useless to anything else on this machine that sees it.
//
// THE TOKEN IS AN ORDINARY ONE. It is listed at term.surf/settings/tokens, named after this machine, and revoked
// there like any other. `--toss` forgets it locally and does not revoke it, and says so.
//
// NO ACCOUNT IS MADE HERE. The Google login must already be a term.surf account with a handle, which is logging in
// once at https://term.surf/login!. term.surf answers with that instruction when it is not.

import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, platform } from 'node:os'
import nodePath from 'node:path'

import { env, keptAt, legacyUserHome, userHome } from '@term/call/code/home'
import { closeRun, field, openRun, report, showPath } from '@term/call/code/output'

// the index `term host` pings, and the same override (`TERM_INDEX_URL`) for a local API
const DEFAULT_INDEX_URL = 'https://tool.term.surf'

// how long the loopback listener waits for the browser to come back before giving up
const WAIT_MS = 5 * 60 * 1000

// how long one call to term.surf may take
const CALL_TIMEOUT_MS = 20_000

// the loopback host Google sends the browser back to. An IP literal rather than `localhost`, which can resolve to
// ::1 on one machine and 127.0.0.1 on another and miss the listener
const LOOPBACK_HOST = '127.0.0.1'

// the page the browser lands on. Plain text, so it renders the same everywhere and carries nothing to exploit
const LANDED = 'Logged in to term.surf. You can close this tab and go back to the terminal.\n'
const REFUSED = 'The login did not finish. Go back to the terminal for the reason.\n'

type Landing = { code: string } | { error: string }

type Verified = {
  token: string
  name?: string
  expires_at?: string | null
  user?: { email?: string | null; slug?: string | null }
}

export async function callBind(input: {
  root: string
  // forget the local token instead of logging in
  toss?: boolean
}): Promise<void> {
  openRun({ verb: 'bind', root: input.root, subject: 'term.surf' })

  const file = keptAt(userHome('auth'), legacyUserHome('auth'))

  if (input.toss) {
    await toss(file)

    return
  }

  const base = (env('INDEX_URL')?.trim() || DEFAULT_INDEX_URL).replace(/\/+$/, '')

  if (!isSafe(base)) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: `${base} is not https, so no token is fetched from it` })
    closeRun({ verdict: 'Not logged in', failure: 'usage' })

    return
  }

  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(24).toString('base64url')

  const listener = await listen(state)
  const redirect = `http://${LOOPBACK_HOST}:${listener.port}/`

  try {
    const started = await post<{ url?: string }>({ base, path: '/sessions/terminal/create!', body: { redirect, challenge, state } })

    if (!started.ok || !started.value.url) {
      report({ glyph: 'failed', kind: 'problem', verb: 'start', subject: started.ok ? 'term.surf did not send a login address' : started.reason })
      closeRun({ verdict: 'Not logged in', failure: 'environment' })

      return
    }

    report({ glyph: 'info', verb: 'open', subject: 'the Google login in your browser', fields: [field('url', started.value.url)] })
    openBrowser(started.value.url)

    const landing = await listener.landing

    if ('error' in landing) {
      report({ glyph: 'failed', kind: 'problem', verb: 'login', subject: landing.error })
      closeRun({ verdict: 'Not logged in', failure: 'environment' })

      return
    }

    const verified = await post<Verified>({
      base,
      path: '/sessions/terminal/verify!',
      body: { code: landing.code, verifier, redirect, machine: hostname() },
    })

    if (!verified.ok || !verified.value.token) {
      report({ glyph: 'failed', kind: 'problem', verb: 'verify', subject: verified.ok ? 'term.surf did not send a token' : verified.reason })
      closeRun({ verdict: 'Not logged in', failure: 'environment' })

      return
    }

    await keep({ file: userHome('auth'), token: verified.value.token })

    const who = verified.value.user?.slug ? `@${verified.value.user.slug}` : (verified.value.user?.email ?? 'your account')
    const fields = [field('token', showPath(userHome('auth'))), field('name', verified.value.name ?? '')]

    if (verified.value.expires_at) {
      fields.push(field('expires', verified.value.expires_at))
    }

    report({ glyph: 'changed', kind: 'change', verb: 'bind', subject: `this machine to ${who}`, fields })

    if (env('TOKEN')) {
      report({ glyph: 'warning', verb: 'check', subject: 'TERM_TOKEN is set, and term host reads it before this file' })
    }

    closeRun({ verdict: `Logged in as ${who}`, done: true, next: 'term host' })
  } finally {
    listener.close()
  }
}

// forget the token on this machine. Revoking it is term.surf's, and the message says where
async function toss(file: string): Promise<void> {
  if (!existsSync(file)) {
    report({ glyph: 'info', verb: 'toss', subject: 'no token on this machine', fields: [field('token', showPath(file))] })
    closeRun({ verdict: 'Nothing to forget' })

    return
  }

  await rm(file)
  report({ glyph: 'changed', kind: 'change', verb: 'toss', subject: 'the term.surf token on this machine', fields: [field('token', showPath(file))] })
  closeRun({
    verdict: 'Logged out on this machine',
    done: true,
    message: ['The token still works until it is revoked at https://term.surf/settings/tokens.'],
  })
}

// write the token alone, readable by this user only, in a directory only this user can enter
async function keep(input: { file: string; token: string }): Promise<void> {
  const dir = nodePath.dirname(input.file)

  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(input.file, `${input.token}\n`, { mode: 0o600 })
  // `mode` applies only when the file is created, so an older token file keeps whatever it had without this
  await chmod(input.file, 0o600)
}

// One loopback listener that answers exactly one landing, then stops listening. `landing` settles with the code, or
// with why there is none: Google's own error, a state that is not ours, or the wait running out.
async function listen(state: string): Promise<{ port: number; landing: Promise<Landing>; close: () => void }> {
  let settle: (landing: Landing) => void = () => {}
  const landing = new Promise<Landing>(resolve => {
    settle = resolve
  })

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)

    // a browser asks for /favicon.ico beside the landing; it is not the answer
    if (url.pathname !== '/') {
      response.writeHead(404).end()

      return
    }

    const answer = readLanding({ url, state })

    response.writeHead('code' in answer ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
    response.end('code' in answer ? LANDED : REFUSED)
    settle(answer)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => resolve())
  })

  const timer = setTimeout(() => settle({ error: `No answer from the browser within ${WAIT_MS / 60_000} minutes` }), WAIT_MS)

  return {
    port: (server.address() as AddressInfo).port,
    landing: landing.finally(() => clearTimeout(timer)),
    close: () => {
      clearTimeout(timer)
      server.close()
      server.closeAllConnections()
    },
  }
}

// what the browser brought back: a code with our state, or the reason it is not one
function readLanding(input: { url: URL; state: string }): Landing {
  const error = input.url.searchParams.get('error')

  if (error) {
    return { error: error === 'access_denied' ? 'The login was cancelled in the browser' : `Google answered ${error}` }
  }

  if (input.url.searchParams.get('state') !== input.state) {
    return { error: 'The browser came back with a state this login did not send, so the answer was ignored' }
  }

  const code = input.url.searchParams.get('code')

  return code ? { code } : { error: 'The browser came back without a code' }
}

// POST JSON to term.surf and read the `{ result }` envelope, or the reason in its `{ note }`
async function post<T>(input: { base: string; path: string; body: Record<string, string> }): Promise<{ ok: true; value: T } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${input.base}${input.path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'term' },
      body: JSON.stringify(input.body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    })
    const answer = (await response.json().catch(() => ({}))) as { result?: T; note?: string }

    if (!response.ok) {
      return { ok: false, reason: answer.note ?? `${response.status} from ${input.base}${input.path}` }
    }

    return answer.result ? { ok: true, value: answer.result } : { ok: false, reason: `${input.base}${input.path} answered without a result` }
  } catch (error) {
    return { ok: false, reason: `${input.base} could not be reached: ${(error as Error).message}` }
  }
}

// open the URL in the default browser. A failure is not one: the URL is already printed
function openBrowser(url: string): void {
  const os = platform()
  const opener: [string, string[]] =
    os === 'darwin' ? ['open', [url]] : os === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]]

  execFile(opener[0], opener[1], () => {})
}

// a token travels only over https, or to a loopback API in development, the rule the publish ping keeps
function isSafe(base: string): boolean {
  try {
    const url = new URL(base)

    return url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  } catch {
    return false
  }
}
