// THE LINE LOCK (decision note/project/term/decision/002-make-line-lock.md, term-cli-in-term-0010).
//
// One lock for `task/port-build.ts` and `make:line`, so two never run at once, and so a live compiler `.tree` (one
// `host/line.js` already uses) is never edited while one runs. port-build compiles with the WORKING TREE's compiler:
// a form case half added to compile/node.tree while another session's make:line ran broke 53 ports on 2026-10-23.
//
// The lock is a directory, `<term>/.base/@term/code/line-lock/`, made with mkdir (atomic: exactly one maker wins),
// holding `holder.json`: who holds it (`by`), the pid that holds it, when, and a token. It is STALE when its pid is
// dead, or, for a lock taken by hand (`take`, whose own process ends at once), when it is older than `--hours`
// (default 20 minutes) without a renewal, or 15 minutes from its take however often it was renewed (THE HAND CAP,
// term-self-host-001-0292). A stale lock is broken by renaming it aside and taken anew.
//
// THE HAND CAP. A hand lease cannot be renewed past 15 minutes in all from its take (`taken` in holder.json): a renew
// after that refuses (exit 3) and prints the holder, and the lock is stale to every other taker. A waiter stuck in a
// renew loop held the lock as `none-held` from 03:32Z to 04:22Z on 2026-10-26 and stalled item 0263 for an hour; under
// the cap such a loop frees the lock by itself. A take under the id `none-held` is refused outright (exit 2).
//
// BREAKING IS COMPARE-AND-BREAK (term-cli-in-term-0155). Every removal of the lock directory (a stale break, a free,
// a renewal's rewrite) happens inside a second mkdir mutex, `line-lock.break/`, held for a few milliseconds, and only
// after the holder read INSIDE it is the exact holder the remover judged (same token, pid, time and item) and, for a
// break, still stale. Until 0155 a breaker checked and then renamed: of two waiters that both judged one dead or
// lapsed lock stale, the slower renamed aside and deleted the lock the faster had just taken, and both ran. A mutex
// left by a breaker that died inside it is cleared after 10 s, the one remaining check-then-act, and it needs a
// process to die within those milliseconds. (A process still running an older copy of this file breaks the old way.)
//
//   node task/term/line-lock.ts take --by <item>     hold it for a live edit (waits). Again by the same item renews it
//   node task/term/line-lock.ts free --by <item>     let it go. Refused (exit 3) when another holds it
//   node task/term/line-lock.ts show                 who holds it, or `free`
//   node task/term/line-lock.ts prove                the lock's own proof on a throwaway root (`status: PASS`)
//   node task/term/line-lock.ts run [--by <item>] -- <command...>
//                                                    hold it while a command runs
//   node task/term/line-lock.ts run --script <name> [--by <item>]
//                                                    hold it while `pnpm run <name>` runs (make:line does this)
//
// `--wait <seconds>` (default 3600) bounds the wait; past it the command exits 3. A process the lock was taken for
// gets TERM_LINE_LOCK=<token> in its environment, and port-build under it sees that token and does not wait on its own
// caller. An item that took the lock by hand passes through its own lock on every run that carries its id:
//
//   pnpm run make:line --by <item>       (or TERM_LINE_LOCK_BY=<item> in the environment)
//   sh tmp/port-one.sh <path> --by <item>                           (port-one sets TERM_LINE_LOCK_BY for port-build)
//   TERM_LINE_LOCK_BY=<item> <any port-build>                       (port-build's own `--by` is its command line)
//
// Without the id the hand holder waits on its own lock like anyone else, since nothing else says the run is its.
// Each pass-through renews the hand lock's time, so an item's builds keep it from lapsing under them.
//
// Plain node (`node task/term/line-lock.ts`, Node strips the types): node builtins only, no TypeScript-only syntax,
// and CommonJS (`require`, `module.exports`), since the root package.json names no module type and an ES module here
// makes node print a reparse warning on every run. port-build loads it by path with a dynamic import.

const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } = require('node:fs')
const { dirname, join, resolve } = require('node:path')

// `at` is the last take or renewal, `taken` the first take (absent in a lock an older copy of this file wrote: `at`)
type Holder = { by: string; pid: number; at: string; token: string; manual: boolean; host: string; taken?: string }

type LockOptions = {
  // the Term package root (the Term root), whose `.base/@term/code/` holds the lock
  term: string
  by: string
  // seconds to wait for another holder before giving up; 0 tries once
  wait?: number
  // a lock taken by hand: no live pid, stale after `hours`
  manual?: boolean
  hours?: number
  // where waiting is told
  say?: (line: string) => void
}

const TOKEN_ENV = 'TERM_LINE_LOCK'
const BY_ENV = 'TERM_LINE_LOCK_BY'

const DEFAULT_WAIT = 3600
// a hand lock lapses after 20 minutes unless renewed (`take` again with the same id): at 2 hours, builders that took
// it for a whole item held a dozen others' make:line waiting an hour (2026-10-23)
const DEFAULT_HOURS = 1 / 3
// THE HAND CAP: a hand lock is held at most this long from its take, renewed or not
const HAND_CAP_MS = 15 * 60_000
// the id a renew loop held the lock under for an hour (2026-10-26): no item is named so, a take under it is refused
const REFUSED_BY = 'none-held'

// how long ago a hand lock was first taken
function handAge(holder: Holder): number {
  return Date.now() - Date.parse(holder.taken ?? holder.at)
}
// a lock directory with no holder.json yet is a taker between its mkdir and its write: stale only once this old
const HALF_MADE_MS = 30_000

// the Term package this file serves: <term>, beside <term>/task/term/
function defaultTerm(): string {
  return (process.env.TERM_ROOT || require('node:path').resolve(__dirname, '../..'))
}

// spelled here, not imported from call/code/home.ts: that module renames old homes as a side effect of loading, and
// this file must run as plain node with no imports of the package
function lockPath(term: string): string {
  return join(term, '.base', '@term', 'code', 'line-lock')
}

function readHolder(term: string): Holder | undefined {
  try {
    return JSON.parse(readFileSync(join(lockPath(term), 'holder.json'), 'utf8')) as Holder
  } catch {
    return undefined
  }
}

function alive(pid: number): boolean {
  if (!(pid > 0)) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists and belongs to someone else
    return (error as { code?: string }).code === 'EPERM'
  }
}

// why the lock at `term` may be broken, or undefined while it holds
function staleReason(term: string, hours = DEFAULT_HOURS): string | undefined {
  const path = lockPath(term)
  const holder = readHolder(term)

  if (!holder) {
    try {
      const age = Date.now() - statSync(path).mtimeMs
      return age > HALF_MADE_MS ? `no holder for ${Math.round(age / 1000)} s` : undefined
    } catch {
      return 'gone'
    }
  }

  if (holder.manual) {
    const held = handAge(holder)

    if (held > HAND_CAP_MS) {
      return `taken by hand ${Math.round(held / 60_000)} min ago, past the ${HAND_CAP_MS / 60_000} min cap`
    }

    const age = Date.now() - Date.parse(holder.at)
    return age > hours * 3600_000 ? `taken by hand ${(age / 3600_000).toFixed(1)} h ago, not renewed` : undefined
  }

  return alive(holder.pid) ? undefined : `pid ${holder.pid} is dead`
}

function describe(holder: Holder | undefined): string {
  if (!holder) {
    return 'being taken'
  }

  return `${holder.by} (${holder.manual ? 'by hand' : `pid ${holder.pid}`}, since ${holder.at})`
}

// the mutex every removal of the lock directory runs inside (BREAKING IS COMPARE-AND-BREAK)
function breakPath(term: string): string {
  return `${lockPath(term)}.break`
}

// a breaker holds the mutex for a few milliseconds: one this old died inside it
const BREAK_HELD_MS = 10_000

// the same holder: the one judged is the one there now. Two absent holders (a lock being taken) are the same
function sameHolder(a: Holder | undefined, b: Holder | undefined): boolean {
  if (!a || !b) {
    return a === b
  }

  return a.token === b.token && a.pid === b.pid && a.at === b.at && a.by === b.by
}

// run `change` holding the break mutex. `busy` when another holds it
function underBreak<T>(term: string, change: () => T): T | 'busy' {
  const path = breakPath(term)

  try {
    mkdirSync(path)
  } catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') {
      throw error
    }

    try {
      if (Date.now() - statSync(path).mtimeMs > BREAK_HELD_MS) {
        rmSync(path, { recursive: true, force: true })
      }
    } catch {
      // gone already
    }

    return 'busy'
  }

  try {
    return change()
  } finally {
    rmSync(path, { recursive: true, force: true })
  }
}

// underBreak, waiting out other breakers: a free or a renewal must not fail because a breaker was mid-step
function underBreakWaiting<T>(term: string, change: () => T): T {
  for (;;) {
    const answer = underBreak(term, change)

    if (answer !== 'busy') {
      return answer
    }

    pause(5)
  }
}

// rename the lock aside (atomic) and delete the copy. Only ever called holding the break mutex
function removeLock(term: string): void {
  const aside = `${lockPath(term)}.stale-${process.pid}-${randomUUID().slice(0, 8)}`

  try {
    renameSync(lockPath(term), aside)
  } catch {
    // gone already (a process running an older copy of this file)
    return
  }

  rmSync(aside, { recursive: true, force: true })
}

// break the lock only if it is still `judged` and still stale. False when it changed, or another breaker is mid-step
function breakStale(term: string, judged: Holder | undefined, hours: number): boolean {
  const broke = underBreak(term, () => {
    if (!existsSync(lockPath(term)) || !sameHolder(readHolder(term), judged) || !staleReason(term, hours)) {
      return false
    }

    removeLock(term)
    return true
  })

  return broke === true
}

// give a hand lock a new time, if it is still `holder`. False when it changed under us
function renewHand(term: string, holder: Holder): boolean {
  return underBreakWaiting(term, () => {
    if (!sameHolder(readHolder(term), holder)) {
      return false
    }

    writeHolder(term, { ...holder, taken: holder.taken ?? holder.at, at: new Date().toISOString() })
    return true
  })
}

function writeHolder(term: string, holder: Holder): void {
  const file = join(lockPath(term), 'holder.json')
  const temporary = `${file}.${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(holder, null, 2)}\n`)
  renameSync(temporary, file)
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type Taken = {
  // false when the lock was already ours (a caller's token, or a hand lock of the same item): free() then does nothing
  owned: boolean
  token: string
  free: () => void
}

// take the lock, waiting for another holder. Throws when the wait runs out
function takeLineLock(options: LockOptions): Taken {
  const { term, by } = options
  const wait = options.wait ?? DEFAULT_WAIT
  const hours = options.hours ?? DEFAULT_HOURS
  const say = options.say ?? ((line: string) => process.stderr.write(`${line}\n`))
  const inherited = process.env[TOKEN_ENV]
  const handBy = process.env[BY_ENV]
  const until = Date.now() + wait * 1000
  let told = ''

  if (by === REFUSED_BY) {
    throw new Error(`line lock: refused, no item is named ${REFUSED_BY}: take it under your item's id`)
  }

  mkdirSync(dirname(lockPath(term)), { recursive: true })

  for (;;) {
    let made = false

    try {
      mkdirSync(lockPath(term))
      made = true
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {
        throw error
      }
    }

    if (made) {
      const token = randomUUID()
      const now = new Date().toISOString()
      const holder: Holder = {
        by,
        pid: options.manual ? 0 : process.pid,
        at: now,
        taken: now,
        token,
        manual: options.manual === true,
        host: process.env.HOSTNAME ?? '',
      }

      try {
        writeHolder(term, holder)
      } catch (error) {
        // the directory was broken as half made (30 s between our mkdir and this write): take it again
        if ((error as { code?: string }).code === 'ENOENT') {
          continue
        }

        throw error
      }

      return { owned: true, token, free: () => freeLineLock({ term, token }) }
    }

    const holder = readHolder(term)

    // ours already: a make:line that runs port-build, or an item that took the lock by hand running make:line or
    // port-one with its id. A hand lock's own use renews it, compared under the break mutex like a break. Past THE HAND
    // CAP a renew by hand refuses, and a run under the item's id breaks the lapsed lock below like any stale one
    const ownHand = holder !== undefined && holder.manual && (holder.by === by || holder.by === handBy)
    const capped = ownHand && handAge(holder!) > HAND_CAP_MS

    if (capped && options.manual) {
      throw new Error(
        `line lock: renew refused, held by ${describe(holder)}, ${Math.round(handAge(holder!) / 60_000)} min from its take, ` +
          `past the ${HAND_CAP_MS / 60_000} min cap. It is stale to every other taker: free it (free --by ${holder!.by}) and take it anew`,
      )
    }

    if (holder && ((inherited && holder.token === inherited) || (ownHand && !capped))) {
      if (holder.manual && !renewHand(term, holder)) {
        continue
      }

      return { owned: false, token: holder.token, free: () => {} }
    }

    const stale = staleReason(term, hours)

    if (stale) {
      if (breakStale(term, holder, hours)) {
        say(`line lock: broke a stale lock of ${describe(holder)}: ${stale}`)
      } else {
        // another breaker was mid-step, or the lock changed since it was read: look again
        pause(5)
      }

      continue
    }

    if (Date.now() >= until) {
      throw new Error(`line lock: held by ${describe(holder)}, still held after ${wait} s (${lockPath(term)})`)
    }

    const now = describe(holder)

    if (now !== told) {
      say(`line lock: waiting for ${now}`)
      told = now
    }

    pause(1000)
  }
}

// free the lock when `token` (or, for a hand lock, `by`) is its holder. False when another holds it
function freeLineLock({ term, token, by }: { term: string; token?: string; by?: string }): boolean {
  return underBreakWaiting(term, () => {
    const holder = readHolder(term)

    if (!existsSync(lockPath(term))) {
      return true
    }

    if (!holder || !((token && holder.token === token) || (by && holder.by === by))) {
      return false
    }

    removeLock(term)
    return true
  })
}

// for port-build: take the lock unless this process runs under it already, and free it when the process ends
function holdForProcess(term: string, by: string): Taken {
  const taken = takeLineLock({ term, by })

  if (taken.owned) {
    const free = (): void => taken.free()
    process.once('exit', free)

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        free()
        process.exit(130)
      })
    }
  }

  return taken
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

function main(argv: string[]): number {
  // `--script <name>` runs `pnpm run <name>` and takes no `--`, so what `pnpm run make:line --by <item>` appends lands
  // among these flags (a bare `--` some pnpm versions pass through is ignored)
  const scripted = argv.includes('--script')
  const dash = scripted ? -1 : argv.indexOf('--')
  const own = dash >= 0 ? argv.slice(0, dash) : argv.filter(arg => arg !== '--')
  const script = flag(own, '--script')
  const command = script ? ['pnpm', 'run', script] : dash >= 0 ? argv.slice(dash + 1) : []
  const verb = own[0]
  const term = flag(own, '--root') ?? defaultTerm()
  const by = flag(own, '--by') ?? process.env[BY_ENV]
  const waitText = flag(own, '--wait')
  const wait = waitText === undefined ? undefined : Number(waitText)
  const hoursText = flag(own, '--hours')
  const hours = hoursText === undefined ? undefined : Number(hoursText)

  if (verb === 'prove') {
    prove()
    return -1
  }

  if (verb === 'show') {
    const holder = readHolder(term)

    if (!existsSync(lockPath(term))) {
      console.log('line lock: free')
      return 0
    }

    const stale = staleReason(term, hours)
    console.log(`line lock: held by ${describe(holder)}${stale ? ` (stale: ${stale})` : ''}`)
    return 0
  }

  if (verb === 'take') {
    if (!by) {
      console.error('line lock: take needs --by <item>')
      return 2
    }

    if (by === REFUSED_BY) {
      console.error(`line lock: refused, no item is named ${REFUSED_BY}: take it under your item's id`)
      return 2
    }

    try {
      const taken = takeLineLock({ term, by, wait, hours, manual: true })
      console.log(`line lock: ${taken.owned ? 'taken' : 'renewed'} by ${by}`)
      return 0
    } catch (error) {
      console.error((error as Error).message)
      return 3
    }
  }

  if (verb === 'free') {
    if (!by) {
      console.error('line lock: free needs --by <item>')
      return 2
    }

    if (freeLineLock({ term, by })) {
      console.log(`line lock: free`)
      return 0
    }

    console.error(`line lock: not freed, held by ${describe(readHolder(term))}`)
    return 3
  }

  if (verb === 'run') {
    if (command.length === 0) {
      console.error('line lock: run needs -- <command...>')
      return 2
    }

    let taken: Taken

    try {
      taken = takeLineLock({ term, by: by ?? (script ?? command.join(' ')).slice(0, 120), wait, hours })
    } catch (error) {
      console.error((error as Error).message)
      return 3
    }

    const child = spawn(command[0]!, command.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, [TOKEN_ENV]: taken.token },
    })
    const forward = (signal: NodeJS.Signals): void => {
      child.kill(signal)
    }

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, forward)
    }

    child.on('exit', (code, signal) => {
      taken.free()
      process.exitCode = code ?? (signal ? 1 : 0)
    })
    child.on('error', error => {
      taken.free()
      console.error(`line lock: ${error.message}`)
      process.exitCode = 1
    })

    return -1
  }

  console.error(
    'usage: line-lock.ts take|free --by <item> | show | prove | run [--by <item>] (--script <name> | -- <command...>)',
  )
  return 2
}

// `prove`: the lock's own proof, on a throwaway root under the system temp folder. A dead holder is broken, a live
// one refuses, a caller's token and a hand lock of the same item pass through, an old hand lock is stale, a hand
// holder's runs pass by `--by` or TERM_LINE_LOCK_BY and renew it while one carrying no id waits, three `run`s
// started at once run one after another, and stale locks raced by six takers at once never have two holders (THE
// STALE-BREAK RACE). Prints `status: PASS`, exit 1 on any failure
function prove(): void {
  const { mkdtempSync } = require('node:fs')
  const { tmpdir } = require('node:os')
  const root: string = mkdtempSync(join(tmpdir(), 'term-line-lock-'))
  const quiet = (): void => {}
  let failed = 0
  const ok = (name: string, holds: boolean): void => {
    console.log(`${holds ? 'ok  ' : 'FAIL'} ${name}`)
    failed += holds ? 0 : 1
  }

  mkdirSync(lockPath(root), { recursive: true })
  writeHolder(root, { by: 'ghost', pid: 999_999, at: new Date().toISOString(), token: 'x', manual: false, host: '' })
  ok('a dead pid is stale', /dead/.test(staleReason(root) ?? ''))
  const first = takeLineLock({ term: root, by: 'one', wait: 0, say: quiet })
  ok('the stale lock is broken and taken', first.owned && readHolder(root)?.by === 'one')

  let refused = false

  try {
    takeLineLock({ term: root, by: 'two', wait: 0, say: quiet })
  } catch {
    refused = true
  }

  ok('a live holder refuses a second taker', refused)
  const saved = process.env[TOKEN_ENV]
  process.env[TOKEN_ENV] = first.token
  ok('the holder token passes through', !takeLineLock({ term: root, by: 'child', wait: 0, say: quiet }).owned)
  if (saved === undefined) {
    delete process.env[TOKEN_ENV]
  } else {
    process.env[TOKEN_ENV] = saved
  }
  first.free()
  ok('freed', !existsSync(lockPath(root)))

  takeLineLock({ term: root, by: 'hand', manual: true, wait: 0 })
  ok('a hand lock passes its own item through', !takeLineLock({ term: root, by: 'hand', wait: 0, say: quiet }).owned)
  const hand = readHolder(root)!
  writeHolder(root, { ...hand, at: new Date(Date.now() - 3 * 3600_000).toISOString() })
  ok('a hand lock 3 h old is stale', /not renewed/.test(staleReason(root) ?? ''))
  ok('and holds under --hours 4', staleReason(root, 4) === undefined)
  ok('freed by its item only', !freeLineLock({ term: root, by: 'other' }) && freeLineLock({ term: root, by: 'hand' }))

  // A HAND HOLDER'S OWN RUNS (term-cli-in-term-0155): what carries its id passes, what does not waits
  const { spawnSync } = require('node:child_process')
  const env = { ...process.env }
  delete env[TOKEN_ENV]
  delete env[BY_ENV]
  takeLineLock({ term: root, by: 'item-7', manual: true, wait: 0, say: quiet })
  const handToken = readHolder(root)!.token
  const printToken = [process.execPath, '-e', `process.stdout.write(process.env.${TOKEN_ENV} ?? '')`]
  const runChild = (args: string[], extra: Record<string, string> = {}): { status: number | null; stdout: string } =>
    spawnSync(process.execPath, [__filename, 'run', '--root', root, '--wait', '0', ...args, '--', ...printToken], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    })
  const byFlag = runChild(['--by', 'item-7'])
  ok('a run with --by <its item> passes, under the hand lock\'s token', byFlag.status === 0 && byFlag.stdout === handToken)
  const byEnv = runChild([], { [BY_ENV]: 'item-7' })
  ok(`a run with ${BY_ENV}=<its item> passes too (what port-one --by sets)`, byEnv.status === 0 && byEnv.stdout === handToken)
  ok('a run carrying no id waits on it (exit 3 at --wait 0)', runChild(['--by', 'port-build --only x']).status === 3)
  const aged = new Date(Date.now() - 15 * 60_000).toISOString()
  writeHolder(root, { ...readHolder(root)!, at: aged })
  const savedBy = process.env[BY_ENV]
  process.env[BY_ENV] = 'item-7'
  ok('port-build under the item\'s id passes in process', !takeLineLock({ term: root, by: 'port-build --only x', wait: 0, say: quiet }).owned)
  if (savedBy === undefined) {
    delete process.env[BY_ENV]
  } else {
    process.env[BY_ENV] = savedBy
  }
  ok('and its pass renews the hand lock', readHolder(root)!.at > aged && readHolder(root)!.token === handToken)
  ok('freed by its item', freeLineLock({ term: root, by: 'item-7' }) && !existsSync(lockPath(root)))

  // THE HAND CAP (term-self-host-001-0292): renewed or not, a hand lock lapses 15 minutes from its take
  const cli = (args: string[]): { status: number | null; stderr: string } =>
    spawnSync(process.execPath, [__filename, ...args, '--root', root, '--wait', '0'], { env, encoding: 'utf8' })
  takeLineLock({ term: root, by: 'item-9', manual: true, wait: 0, say: quiet })
  const firstTake = readHolder(root)!.taken
  writeHolder(root, { ...readHolder(root)!, taken: new Date(Date.now() - 14 * 60_000).toISOString() })
  const early = readHolder(root)!
  ok('a hand lock 14 min from its take renews', cli(['take', '--by', 'item-9']).status === 0 && readHolder(root)!.at > early.at)
  ok('and the renewal keeps its take time', firstTake !== undefined && readHolder(root)!.taken === early.taken)
  writeHolder(root, { ...readHolder(root)!, taken: new Date(Date.now() - 16 * 60_000).toISOString(), at: new Date().toISOString() })
  const late = readHolder(root)!
  ok('16 min from its take, renewed a moment ago, it is stale', /past the 15 min cap/.test(staleReason(root) ?? ''))
  const refusedRenew = cli(['take', '--by', 'item-9'])
  ok('a renew past the cap refuses (exit 3) and prints the holder', refusedRenew.status === 3 && /renew refused, held by item-9/.test(refusedRenew.stderr))
  ok('and leaves the holder as it was', sameHolder(readHolder(root), late))
  let refusedInProcess = false
  try {
    takeLineLock({ term: root, by: 'item-9', manual: true, wait: 0, say: quiet })
  } catch (error) {
    refusedInProcess = /renew refused/.test((error as Error).message)
  }
  ok('the same in process', refusedInProcess)
  const after = takeLineLock({ term: root, by: 'waiter', wait: 0, say: quiet })
  ok('another taker breaks the capped lock and takes it', after.owned && readHolder(root)?.by === 'waiter')
  after.free()
  takeLineLock({ term: root, by: 'item-10', manual: true, wait: 0, say: quiet })
  const tenToken = readHolder(root)!.token
  writeHolder(root, { ...readHolder(root)!, taken: new Date(Date.now() - 16 * 60_000).toISOString(), at: new Date().toISOString() })
  const ownRun = runChild(['--by', 'item-10'])
  ok('a run under the item\'s own id past the cap breaks it and runs under a fresh token', ownRun.status === 0 && ownRun.stdout.length > 0 && ownRun.stdout !== tenToken)
  ok('and leaves the lock free', !existsSync(lockPath(root)))
  ok(`a take under the id ${REFUSED_BY} is refused (exit 2)`, cli(['take', '--by', REFUSED_BY]).status === 2 && !existsSync(lockPath(root)))
  let refusedNone = false
  try {
    takeLineLock({ term: root, by: REFUSED_BY, wait: 0, say: quiet })
  } catch {
    refusedNone = true
  }
  ok(`and in process, run or by hand`, refusedNone && !existsSync(lockPath(root)))

  const log = join(root, 'log')
  writeFileSync(log, '')
  const body = `const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'start\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'end\\n'),1500)`
  const three = Promise.all(
    ['a', 'b', 'c'].map(
      by =>
        new Promise<void>(done => {
          spawn(process.execPath, [__filename, 'run', '--root', root, '--by', by, '--', process.execPath, '-e', body], {
            stdio: 'ignore',
            env,
          }).on('exit', () => done())
        }),
    ),
  )

  three
    .then(() => {
      ok('three runs at once run one after another', readFileSync(log, 'utf8').trim().split('\n').join(',') === 'start,end,start,end,start,end')
      ok('and leave the lock free', !existsSync(lockPath(root)))
      return raceStale(root, env, ok)
    })
    .then(() => {
      rmSync(root, { recursive: true, force: true })
      console.log(failed === 0 ? 'status: PASS' : `status: FAIL (${failed})`)
      process.exitCode = failed === 0 ? 0 : 1
    })
}

// THE STALE-BREAK RACE (term-cli-in-term-0155). Each round leaves a stale lock (a dead pid, a lapsed hand lock, or a
// directory half made long ago) and starts six takers that spin to one shared instant and then take at once, wait 0:
// each that takes logs `start`, holds 400 ms, logs `end`, frees. Two `start`s without an `end` between is two holders.
// TERM_LINE_LOCK_PROVE_MODULE=<abs path to a copy of this file> races that copy instead (the proof ran the copy from
// before 0155, and it fails here)
const RACE_ROUNDS = 48
const RACE_BATCH = 8
const RACE_TAKERS = 6

async function raceStale(root: string, env: Record<string, string | undefined>, ok: (name: string, holds: boolean) => void): Promise<void> {
  const { spawnSync } = require('node:child_process')
  const { utimesSync } = require('node:fs')
  const raced = process.env.TERM_LINE_LOCK_PROVE_MODULE ?? __filename
  const taker = [
    `const fs=require('fs');const l=require(${JSON.stringify(raced)});`,
    `const [term,log,at,by]=process.argv.slice(1);while(Date.now()<Number(at)){}`,
    `let t;try{t=l.takeLineLock({term,by,wait:0,say(){}})}catch{fs.appendFileSync(log,'refused\\n');process.exit(0)}`,
    `fs.appendFileSync(log,'start\\n');const e=Date.now()+400;while(Date.now()<e){}`,
    `fs.appendFileSync(log,'end\\n');t.free()`,
  ].join('')
  // a pid that was alive a moment ago and is not now
  const dead: number = spawnSync(process.execPath, ['-e', '0']).pid
  let overlapped = 0
  let untaken = 0
  let left = 0
  let broken = 0

  for (let batch = 0; batch < RACE_ROUNDS; batch += RACE_BATCH) {
    const at = Date.now() + 1500
    const rounds: Promise<void>[] = []

    for (let round = batch; round < batch + RACE_BATCH; round++) {
      const term = join(root, `race-${round}`)
      const log = join(term, 'log')
      mkdirSync(lockPath(term), { recursive: true })
      writeFileSync(log, '')
      const kind = round % 3
      const old = new Date(Date.now() - 3 * 3600_000)

      if (kind === 0) {
        writeHolder(term, { by: 'ghost', pid: dead, at: new Date().toISOString(), token: randomUUID(), manual: false, host: '' })
      } else if (kind === 1) {
        writeHolder(term, { by: 'lapsed', pid: 0, at: old.toISOString(), token: randomUUID(), manual: true, host: '' })
      } else {
        utimesSync(lockPath(term), old, old)
      }

      const takers = Array.from(
        { length: RACE_TAKERS },
        (_, index) =>
          new Promise<void>(done => {
            spawn(process.execPath, ['-e', taker, term, log, String(at), `taker-${index}`], { stdio: 'ignore', env }).on('exit', () =>
              done(),
            )
          }),
      )

      rounds.push(
        Promise.all(takers).then(() => {
          let depth = 0
          let starts = 0

          for (const line of readFileSync(log, 'utf8').trim().split('\n')) {
            if (line === 'start') {
              starts++
              depth++
              overlapped += depth > 1 ? 1 : 0
            } else if (line === 'end') {
              depth--
            }
          }

          broken += starts > 0 ? 1 : 0
          untaken += starts === 0 ? 1 : 0
          left += existsSync(lockPath(term)) || existsSync(breakPath(term)) ? 1 : 0
        }),
      )
    }

    await Promise.all(rounds)
  }

  console.log(`     race: ${RACE_ROUNDS} rounds x ${RACE_TAKERS} takers, ${broken} broken, ${overlapped} overlaps, ${untaken} untaken`)
  ok(`${RACE_ROUNDS} stale locks raced by ${RACE_TAKERS} takers: never two holders at once`, overlapped === 0)
  ok('every stale lock was broken and taken', untaken === 0)
  ok('and each left free, break mutex gone', left === 0)
}

module.exports = {
  TOKEN_ENV,
  BY_ENV,
  defaultTerm,
  lockPath,
  readHolder,
  staleReason,
  describe,
  takeLineLock,
  freeLineLock,
  holdForProcess,
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  const code = main(process.argv.slice(2))

  if (code >= 0) {
    process.exitCode = code
  }
}
