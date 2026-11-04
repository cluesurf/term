// The input tracker for the `pnpm term:test` result cache (task/term/test.ts). Preloaded into every Node process a
// suite starts (NODE_OPTIONS=--require), it records what the process READ: every file opened for reading, every
// directory listed, and every path whose existence was asked and found absent. A suite whose recorded inputs are all
// unchanged since it last passed cannot answer differently, so the gate reuses that pass instead of running it.
//
// What it cannot see, and what the gate adds for it instead:
//   - TypeScript a suite IMPORTS: Node runs ESM loader hooks (tsx) on another thread, out of reach of a patched
//     `fs`. The gate takes each suite script's import closure from esbuild's metafile instead.
//   - files a non-Node program reads (rustc, swiftc, kotlinc, cargo). The tracker records which programs a process
//     spawned, and the gate adds the native runtime trees and the toolchain versions for a suite that ran one.
//
// Each path is APPENDED the moment it is first seen, to `<TERM_GATE_TRACK>/<pid>-<thread>.txt`, one `<kind>\t<path>`
// per line (h read with the sha1 of the bytes returned, r read with no hash taken, l listed, a absent, w written,
// s spawned, e a script the process was started on, b a process began). Appending as it goes, rather than writing at exit, is what keeps
// a worker thread that is terminated, or a process that is killed, from losing what it read. Never changes what a
// call returns.

'use strict'

const out = process.env.TERM_GATE_TRACK

if (out) {
  const fs = require('node:fs')
  const path = require('node:path')
  const { syncBuiltinESMExports } = require('node:module')
  const { threadId } = require('node:worker_threads')
  const childProcess = require('node:child_process')

  // the original appender, taken before anything is wrapped, so recording never records itself
  const append = fs.appendFileSync
  const file = path.join(out, `${process.pid}-${threadId}.txt`)
  const seen = new Set()
  let broken = false

  try {
    fs.mkdirSync(out, { recursive: true })
  } catch {
    broken = true
  }

  const record = (kind, p, hash) => {
    if (broken) {
      return
    }

    let resolved

    if (typeof p === 'string') {
      // a spawned program is a name, not a path
      resolved = kind === 's' ? p : path.resolve(p)
    } else if (p instanceof URL && p.protocol === 'file:') {
      resolved = path.resolve(decodeURIComponent(p.pathname))
    } else {
      return
    }

    const line = hash === undefined ? `${kind}\t${resolved}` : `${kind}\t${resolved}\t${hash}`

    if (seen.has(line)) {
      return
    }

    seen.add(line)

    // the main thread buffers and writes at exit, which every ordinary end of a process reaches (a suite killed
    // outright has failed, and a failure is never cached). A worker thread writes at once, because a terminated
    // worker gets no exit event and would take its record with it. One append per path on the main thread cost a
    // third of a cold build's time (build-time: 39s untracked, 52s tracked, 2026-10-02).
    if (threadId === 0) {
      pending.push(line)

      return
    }

    try {
      append(file, `${line}\n`)
    } catch {
      // a record that cannot be written leaves the suite uncached (the gate sees the marker below is missing)
      broken = true
    }
  }

  const pending = []

  process.on('exit', () => {
    if (pending.length > 0 && !broken) {
      try {
        append(file, `${pending.join('\n')}\n`)
      } catch {
        // as above
      }
    }
  })

  const wrap = (object, name, onCall) => {
    const original = object[name]

    if (typeof original !== 'function') {
      return
    }

    object[name] = function tracked(...args) {
      try {
        onCall(args)
      } catch {
        // tracking never changes what the call does
      }

      return original.apply(this, args)
    }
  }

  const statSync = fs.statSync
  // diagnosis only: TERM_GATE_TRACK_OFF=hash,exists,write turns a piece of the tracker off, to measure what it costs
  const off = new Set((process.env.TERM_GATE_TRACK_OFF ?? '').split(','))
  const readingFlag = flags => flags === undefined || flags === 'r' || flags === 'rs' || flags === 'r+' || flags === 0
  const { createHash } = require('node:crypto')
  const digest = bytes => createHash('sha1').update(bytes).digest('hex')

  // readFileSync is where almost every input arrives, so it records the hash of the bytes it actually returned: the
  // file as THIS suite saw it, not as it stands after some other suite rewrote it later in the same run. Read as raw
  // bytes, hashed, then decoded the way the caller asked, which is what readFileSync does itself.
  const readFileSync = fs.readFileSync

  fs.readFileSync = function trackedReadFileSync(p, options) {
    const encoding = typeof options === 'string' ? options : options?.encoding
    const flag = typeof options === 'object' && options !== null ? options.flag : undefined

    if (typeof p === 'number' || (flag !== undefined && flag !== 'r')) {
      return readFileSync.apply(this, arguments)
    }

    if (off.has('hash')) {
      record('r', p)

      return readFileSync.apply(this, arguments)
    }

    const bytes = readFileSync.call(this, p, flag === undefined ? undefined : { flag })

    try {
      record('h', p, digest(bytes))
    } catch {
      // tracking never changes what the call does
    }

    return encoding ? bytes.toString(encoding) : bytes
  }

  for (const name of ['readFile', 'createReadStream']) {
    wrap(fs, name, ([p]) => record('r', p))
  }

  for (const name of ['openSync', 'open']) {
    wrap(fs, name, ([p, flags]) => {
      if (readingFlag(typeof flags === 'function' ? undefined : flags)) {
        record('r', p)
      }
    })
  }

  for (const name of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) {
    wrap(fs, name, ([p]) => record('l', p))
  }

  // what the process WROTE: a file a suite writes is its output, and the gate leaves it out of the inputs even when
  // the suite reads it back
  for (const name of ['writeFileSync', 'writeFile', 'appendFileSync', 'appendFile', 'createWriteStream', 'truncateSync', 'truncate']) {
    wrap(fs, name, ([p]) => record('w', p))
  }

  for (const name of ['renameSync', 'rename', 'copyFileSync', 'copyFile', 'cpSync', 'cp', 'symlinkSync', 'symlink', 'linkSync', 'link']) {
    wrap(fs, name, ([, to]) => record('w', to))
  }

  for (const name of ['openSync', 'open']) {
    wrap(fs, name, ([p, flags]) => {
      if (!readingFlag(typeof flags === 'function' ? undefined : flags)) {
        record('w', p)
      }
    })
  }

  for (const name of ['writeFile', 'appendFile']) {
    wrap(fs.promises, name, ([p]) => record('w', p))
  }

  for (const name of ['rename', 'copyFile', 'cp']) {
    wrap(fs.promises, name, ([, to]) => record('w', to))
  }

  if (!off.has('exists')) {
    wrap(fs, 'existsSync', ([p]) => {
      if (typeof p === 'string' && !statSync(p, { throwIfNoEntry: false })) {
        record('a', p)
      }
    })
  }

  for (const name of ['readFile', 'open']) {
    wrap(fs.promises, name, ([p, flags]) => {
      if (name === 'readFile' || readingFlag(flags)) {
        record('r', p)
      }
    })
  }

  for (const name of ['readdir', 'opendir']) {
    wrap(fs.promises, name, ([p]) => record('l', p))
  }

  for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) {
    wrap(childProcess, name, ([command]) => {
      if (typeof command === 'string') {
        record('s', path.basename(command.trim().split(/\s+/)[0]))
      }
    })
  }

  // ESM `import { readFileSync } from 'node:fs'` binds the export, not the property: re-export the patched ones
  syncBuiltinESMExports()

  // the marker the gate looks for: this process started tracking. A process with a start and no record lines read
  // nothing, which is a fact, not a gap
  record('b', process.argv[1] ?? '')

  // the scripts this process was started on (`node host/line.js`, `npx tsx test/x.ts`): a main module loads outside
  // the patched `fs`, so the gate takes each one's import closure from esbuild instead
  for (const arg of process.argv.slice(1)) {
    if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(arg) && statSync(arg, { throwIfNoEntry: false })?.isFile()) {
      record('e', arg)
    }
  }
}
