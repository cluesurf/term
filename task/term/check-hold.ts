// The machine-wide device hold (beat-term-0035, spec.md 4 D017): `holdDevice` in
// test/compile/shared/device-hold.ts. Each case runs under a fresh TERM_HOLD_HOME, so it never
// touches the real hold under ~/.base/hold and never waits on a person's run. Nothing here drives a device.
//
//   npx tsx task/term/check-hold.ts
//
// Prints `ok` or `FAIL` per case and `N pass, M fail` last; exits 1 on a fail. A child is this same script run again
// with `child` as its first argument: it takes the hold, prints when, and waits. `child-sync` is the same through
// `holdDeviceSync` (beat-term-0036, D024), holding by a blocked thread as a `spawnSync` would.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { holdDevice, holdDeviceSync, holderOf } from '../../test/compile/shared/device-hold'

// the child: `child <device> <who> <hold ms>`. Prints `held <ms>` once it holds, `releasing <ms>` just before it lets go
async function runChild(): Promise<void> {
  const [device, who, ms] = process.argv.slice(3)
  const release = await holdDevice(device as 'simulator' | 'emulator' | 'pasteboard', who)

  console.log(`held ${Date.now()}`)

  await new Promise(resolve => setTimeout(resolve, Number(ms)))
  console.log(`releasing ${Date.now()}`)
  release()
  process.exit(0)
}

function block(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

// the sync child: `child-sync <device> <who> <hold ms>`. Holds by `Atomics.wait`, so its event loop never turns, and
// writes with `writeSync` (a `console.log` to a pipe on macOS can wait for the event loop)
function runChildSync(): void {
  const [device, who, ms] = process.argv.slice(3)
  const release = holdDeviceSync(device as 'simulator' | 'emulator' | 'pasteboard', who)

  writeSync(1, `held ${Date.now()}\n`)
  block(Number(ms))
  writeSync(1, `releasing ${Date.now()}\n`)
  release()
  process.exit(0)
}

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

type Child = { run: ChildProcess, lines: string[], closed: Promise<{ status: number | null, signal: string | null }> }

// the script is run again as a child, under the same loader the parent runs under
function start(device: string, who: string, holdMs: number, mode: 'child' | 'child-sync' = 'child'): Child {
  const run = spawn(process.execPath, [...process.execArgv, process.argv[1], mode, device, who, String(holdMs)], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const lines: string[] = []

  run.stdout!.on('data', chunk => lines.push(...String(chunk).split('\n').filter(line => line !== '')))
  run.stderr!.on('data', chunk => lines.push(...String(chunk).split('\n').filter(line => line !== '').map(line => `stderr ${line}`)))

  const closed = new Promise<{ status: number | null, signal: string | null }>(resolve => {
    run.on('close', (status, signal) => resolve({ status, signal }))
  })

  return { run, lines, closed }
}

async function lineOf(child: Child, prefix: string, seconds = 60): Promise<number | undefined> {
  const until = Date.now() + seconds * 1000

  while (Date.now() < until) {
    const line = child.lines.find(text => text.startsWith(`${prefix} `))

    if (line) {
      return Number(line.slice(prefix.length + 1))
    }

    await new Promise(resolve => setTimeout(resolve, 20))
  }

  return undefined
}

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'term-hold-check-'))

  process.env.TERM_HOLD_HOME = home
  delete process.env.TERM_HELD

  return home
}

function deadPid(): number {
  return spawnSync(process.execPath, ['-e', '0']).pid!
}

// 1. a hold taken by a child makes a second child wait, and the second takes it within 3 s of the first releasing
async function waitsForTheHolder(): Promise<void> {
  const home = freshHome()
  const first = start('simulator', 'check-first', 5000)
  const heldFirst = await lineOf(first, 'held')

  ok('first child holds', heldFirst !== undefined && existsSync(join(home, 'simulator', 'owner.json')), first.lines.join(' | '))
  ok('holderOf names the first child', holderOf('simulator')?.who === 'check-first' && holderOf('simulator')?.pid === first.run.pid, JSON.stringify(holderOf('simulator')))

  const second = start('simulator', 'check-second', 200)

  // the second says who holds it, once (a child takes about a second to start, so wait for the words), and has not
  // taken it while the first holds
  for (let wait = 0; wait < 400 && !second.lines.some(line => line.includes('check-first')); wait++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  ok('second child says who holds it', second.lines.some(line => line.includes('check-first')), second.lines.join(' | '))
  ok('second child waits while the first holds', !second.lines.some(line => line.startsWith('held ')), second.lines.join(' | '))

  const heldSecond = await lineOf(second, 'held')
  const releasing = await lineOf(first, 'releasing')

  await first.closed
  await second.closed
  ok('second child takes it after the first releases', heldSecond !== undefined && releasing !== undefined && heldSecond >= releasing, `first releasing ${releasing}, second held ${heldSecond}`)
  ok('second child takes it within 3 s of the release', heldSecond !== undefined && releasing !== undefined && heldSecond - releasing < 3000, `first releasing ${releasing}, second held ${heldSecond}`)
  ok('no lock is left once both are done', !existsSync(join(home, 'simulator')), 'the folder is still there')
  console.log(`      witness: first held ${heldFirst}, first releasing ${releasing}, second held ${heldSecond} (ms since the epoch)`)
}

// 2. a lock left by a pid that is not alive is taken at once
async function takesAStaleLock(): Promise<void> {
  const home = freshHome()
  const dead = deadPid()

  mkdirSync(join(home, 'emulator'), { recursive: true })
  writeFileSync(join(home, 'emulator', 'owner.json'), JSON.stringify({ pid: dead, who: 'ghost', since: new Date().toISOString() }))
  ok('holderOf ignores a holder whose process is gone', holderOf('emulator') === undefined, JSON.stringify(holderOf('emulator')))

  const started = Date.now()
  const release = await holdDevice('emulator', 'check-stale')
  const took = Date.now() - started

  ok('a stale lock is taken at once', took < 500, `took ${took} ms`)
  ok('the new owner is this process', holderOf('emulator')?.pid === process.pid && holderOf('emulator')?.who === 'check-stale', JSON.stringify(holderOf('emulator')))
  release()
  ok('release removes the lock', !existsSync(join(home, 'emulator')), 'the folder is still there')
}

// 3. a lock with no owner.json older than 10 s is stale (a taker that died between the mkdir and the write)
async function takesAnOrphanLock(): Promise<void> {
  const home = freshHome()
  const dir = join(home, 'pasteboard')

  mkdirSync(dir, { recursive: true })

  const old = new Date(Date.now() - 60_000)

  utimesSync(dir, old, old)

  const started = Date.now()
  const release = await holdDevice('pasteboard', 'check-orphan')

  ok('an old lock with no owner.json is taken at once', Date.now() - started < 500 && holderOf('pasteboard')?.pid === process.pid, `took ${Date.now() - started} ms`)
  release()
}

// 4. TERM_HELD=simulator answers at once while another process holds it
async function answersAtOnceUnderTermHeld(): Promise<void> {
  freshHome()

  const first = start('simulator', 'check-ancestor', 3000)

  await lineOf(first, 'held')
  process.env.TERM_HELD = 'emulator,simulator'

  const started = Date.now()
  const release = await holdDevice('simulator', 'check-descendant')
  const took = Date.now() - started

  ok('TERM_HELD answers at once while another process holds it', took < 500, `took ${took} ms`)
  ok('the lock still names the real holder', holderOf('simulator')?.who === 'check-ancestor', JSON.stringify(holderOf('simulator')))
  release()
  ok('the answered release leaves the real holder\'s lock', holderOf('simulator')?.who === 'check-ancestor', JSON.stringify(holderOf('simulator')))
  delete process.env.TERM_HELD
  first.run.kill('SIGTERM')
  await first.closed
}

// 5. a release by a process that no longer owns the lock leaves the lock
async function leavesALockItDoesNotOwn(): Promise<void> {
  const home = freshHome()
  const release = await holdDevice('emulator', 'check-lost')
  const owner = join(home, 'emulator', 'owner.json')
  const taken = JSON.parse(readFileSync(owner, 'utf8')) as { pid: number }

  // another process has the lock now (a stale rename and a new take, as far as this one can tell)
  writeFileSync(owner, JSON.stringify({ ...taken, pid: process.ppid, who: 'check-successor' }))
  release()
  ok('a release by a process that does not own the lock leaves it', existsSync(join(home, 'emulator')) && JSON.parse(readFileSync(owner, 'utf8')).who === 'check-successor', 'the lock was removed')
}

// 6. a child killed with SIGTERM while holding leaves no lock, and still dies of the signal
async function releasesOnSigterm(): Promise<void> {
  const home = freshHome()
  const child = start('emulator', 'check-killed', 60_000)

  ok('the child to kill holds', (await lineOf(child, 'held')) !== undefined && existsSync(join(home, 'emulator')), child.lines.join(' | '))
  child.run.kill('SIGTERM')

  const ended = await child.closed

  ok('a child killed with SIGTERM leaves no lock', !existsSync(join(home, 'emulator')), 'the folder is still there')
  ok('its exit stays the signal\'s', ended.signal === 'SIGTERM', `status ${ended.status}, signal ${ended.signal}`)
}

// waits until `child` has said who holds the device (a child takes about a second to start), up to 20 s
async function saysWhoHolds(child: Child, who: string): Promise<boolean> {
  for (let wait = 0; wait < 400 && !child.lines.some(line => line.includes(who)); wait++) {
    await new Promise(resolve => setTimeout(resolve, 50))
  }

  return child.lines.some(line => line.includes(who))
}

// 7. a sync child waits for an async holder (the two doors are one mechanism)
async function syncWaitsForAsync(): Promise<void> {
  freshHome()

  const holder = start('simulator', 'check-async-holder', 4000)

  await lineOf(holder, 'held')

  const waiter = start('simulator', 'check-sync-waiter', 200, 'child-sync')

  ok('sync child says who holds it', await saysWhoHolds(waiter, 'check-async-holder'), waiter.lines.join(' | '))
  ok('sync child waits while the async child holds', !waiter.lines.some(line => line.startsWith('held ')), waiter.lines.join(' | '))

  const heldWaiter = await lineOf(waiter, 'held')
  const releasing = await lineOf(holder, 'releasing')

  await holder.closed
  await waiter.closed
  ok('sync child takes it after the async child releases', heldWaiter !== undefined && releasing !== undefined && heldWaiter >= releasing, `async releasing ${releasing}, sync held ${heldWaiter}`)
  ok('sync child takes it within 3 s of the release', heldWaiter !== undefined && releasing !== undefined && heldWaiter - releasing < 3000, `async releasing ${releasing}, sync held ${heldWaiter}`)
}

// 8. an async child waits for a sync holder
async function asyncWaitsForSync(): Promise<void> {
  const home = freshHome()
  const holder = start('simulator', 'check-sync-holder', 4000, 'child-sync')

  await lineOf(holder, 'held')

  const waiter = start('simulator', 'check-async-waiter', 200)

  await saysWhoHolds(waiter, 'check-sync-holder')
  ok('async child waits while the sync child holds', !waiter.lines.some(line => line.startsWith('held ')), waiter.lines.join(' | '))

  const heldWaiter = await lineOf(waiter, 'held')
  const releasing = await lineOf(holder, 'releasing')

  await holder.closed
  await waiter.closed
  ok('async child takes it after the sync child releases', heldWaiter !== undefined && releasing !== undefined && heldWaiter >= releasing, `sync releasing ${releasing}, async held ${heldWaiter}`)
  ok('async child takes it within 3 s of the release', heldWaiter !== undefined && releasing !== undefined && heldWaiter - releasing < 3000, `sync releasing ${releasing}, async held ${heldWaiter}`)
  ok('no lock is left once both are done', !existsSync(join(home, 'simulator')), 'the folder is still there')
}

// 9. TERM_HELD answers holdDeviceSync at once while another process holds it
async function syncAnswersUnderTermHeld(): Promise<void> {
  freshHome()

  const first = start('simulator', 'check-ancestor', 3000)

  await lineOf(first, 'held')
  process.env.TERM_HELD = 'emulator,simulator'

  const started = Date.now()
  const release = holdDeviceSync('simulator', 'check-descendant')
  const took = Date.now() - started

  ok('TERM_HELD answers holdDeviceSync at once while another process holds it', took < 500, `took ${took} ms`)
  release()
  ok('holdDeviceSync\'s answered release leaves the real holder\'s lock', holderOf('simulator')?.who === 'check-ancestor', JSON.stringify(holderOf('simulator')))
  delete process.env.TERM_HELD
  first.run.kill('SIGTERM')
  await first.closed
}

// 10. holdDeviceSync takes a stale lock at once and its release removes the lock
async function syncTakesAStaleLock(): Promise<void> {
  const home = freshHome()
  const dead = deadPid()

  mkdirSync(join(home, 'emulator'), { recursive: true })
  writeFileSync(join(home, 'emulator', 'owner.json'), JSON.stringify({ pid: dead, who: 'ghost', since: new Date().toISOString() }))

  const started = Date.now()
  const release = holdDeviceSync('emulator', 'check-sync-stale')
  const took = Date.now() - started

  ok('holdDeviceSync takes a stale lock at once', took < 500 && holderOf('emulator')?.pid === process.pid, `took ${took} ms, ${JSON.stringify(holderOf('emulator'))}`)
  release()
  ok('holdDeviceSync\'s release removes the lock', !existsSync(join(home, 'emulator')), 'the folder is still there')
}

// 11. a sync holder killed with SIGTERM dies at once, by the signal, and leaves a folder the next taker clears
async function sigtermEndsASyncHolder(): Promise<void> {
  const home = freshHome()
  const child = start('emulator', 'check-sync-killed', 60_000, 'child-sync')

  await lineOf(child, 'held')

  const sent = Date.now()

  child.run.kill('SIGTERM')

  const ended = await child.closed
  const took = Date.now() - sent

  ok('a SIGTERM ends a sync holder within 1 s', took < 1000, `took ${took} ms`)
  ok('its exit is the signal\'s', ended.signal === 'SIGTERM', `status ${ended.status}, signal ${ended.signal}`)
  ok('holderOf ignores the folder it left', existsSync(join(home, 'emulator')) && holderOf('emulator') === undefined, `${existsSync(join(home, 'emulator'))} ${JSON.stringify(holderOf('emulator'))}`)

  const started = Date.now()
  const release = holdDeviceSync('emulator', 'check-after-kill')

  ok('holdDeviceSync takes the folder it left at once', Date.now() - started < 500 && holderOf('emulator')?.who === 'check-after-kill', `took ${Date.now() - started} ms`)
  release()
}

// 12. a sync child WAITING (on an async child's hold) killed with SIGTERM dies at once and leaves the holder's lock alone
async function sigtermEndsASyncWaiter(): Promise<void> {
  freshHome()

  const holder = start('emulator', 'check-async-keeper', 60_000)

  await lineOf(holder, 'held')

  const waiter = start('emulator', 'check-sync-waiting', 200, 'child-sync')

  await saysWhoHolds(waiter, 'check-async-keeper')

  const sent = Date.now()

  waiter.run.kill('SIGTERM')
  await waiter.closed
  ok('a SIGTERM ends a sync waiter within 1 s', Date.now() - sent < 1000, `took ${Date.now() - sent} ms`)
  ok('the holder\'s lock is untouched', holderOf('emulator')?.who === 'check-async-keeper' && holderOf('emulator')?.pid === holder.run.pid, JSON.stringify(holderOf('emulator')))
  holder.run.kill('SIGTERM')
  await holder.closed
}

async function main(): Promise<void> {
  await waitsForTheHolder()
  await takesAStaleLock()
  await takesAnOrphanLock()
  await answersAtOnceUnderTermHeld()
  await leavesALockItDoesNotOwn()
  await releasesOnSigterm()
  await syncWaitsForAsync()
  await asyncWaitsForSync()
  await syncAnswersUnderTermHeld()
  await syncTakesAStaleLock()
  await sigtermEndsASyncHolder()
  await sigtermEndsASyncWaiter()

  console.log(`\ncheck-hold: ${pass} pass, ${fail} fail`)
  process.exit(fail ? 1 : 0)
}

if (process.argv[2] === 'child') {
  runChild()
} else if (process.argv[2] === 'child-sync') {
  runChildSync()
} else {
  main()
}
