// task/port-trace.ts files a read-only `openSync` of a path as a read of it, and reads through that descriptor as
// nothing it cannot describe (item term-self-host-001-1041). From node 23 the ESM loader under tsx's synchronous hooks
// loads a module's source with node's ORIGINAL `readFileSync`, which opens and reads through the `fs` module object, so
// its `openSync` and `readSync` reached the trace at depth 0. They marked the process untrackable, and port-build, which
// loads stage0 through that loader, skipped no module on node 24. Each case runs in its own process, since an
// untrackable read is sticky for the rest of one.
//
//   loader      node's original readFileSync of a Buffer: filed as a read of the file, not untrackable
//   import      a dynamic import of a module under the trace (on node 24 the loader's own path): not untrackable
//   foreign-fd  a readSync through a descriptor the trace never saw opened: untrackable
//   write-open  an openSync for writing: untrackable
//   fstat       an fstatSync of a read-only descriptor: not untrackable
//
//   npx tsx test/call/port-trace-descriptor.ts      (from deck/term/deck/term)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tempDir } from '../temp'

const mode = process.argv[2]

if (mode !== undefined) {
  // a case, in a process of its own: the trace is imported before anything reads
  const trace = await import('../../task/port-trace')
  const dir = process.argv[3]!
  const file = join(dir, 'data.txt')

  trace.setRecording(true)
  trace.beginModule()

  if (mode === 'loader') {
    trace.real.readFileSync(file)
  } else if (mode === 'import') {
    await import(pathToFileURL(join(dir, 'probe.mjs')).href)
  } else if (mode === 'foreign-fd') {
    const fd = trace.untraced(() => fs.openSync(file, 'r'))
    fs.readSync(fd, Buffer.alloc(4), 0, 4, 0)
    trace.untraced(() => fs.closeSync(fd))
  } else if (mode === 'write-open') {
    fs.closeSync(fs.openSync(join(dir, 'written.txt'), 'w'))
  } else if (mode === 'fstat') {
    const fd = fs.openSync(file, 'r')
    fs.fstatSync(fd)
    fs.closeSync(fd)
  }

  const keys = trace.endModule()

  console.log(JSON.stringify({ untrackable: keys.includes(trace.UNTRACKABLE), read: keys.includes(`read\0${file}`) }))
  process.exit(0)
}

let failed = 0

function ok(name: string, cond: boolean, info = ''): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !info ? '' : `: ${info}`}`)

  if (!cond) {
    failed++
  }
}

const TSX = createRequire(import.meta.url).resolve('tsx/cli')
const dir = fs.realpathSync(tempDir('term-port-trace-descriptor-'))

fs.writeFileSync(join(dir, 'data.txt'), 'some content\n')
fs.writeFileSync(join(dir, 'probe.mjs'), 'export const probe = 1\n')

function run(name: string): { untrackable: boolean; read: boolean } {
  const out = execFileSync(process.execPath, [TSX, import.meta.filename, name, dir], { encoding: 'utf8' })

  return JSON.parse(out.trim().split('\n').pop()!)
}

const loader = run('loader')

ok(`loader (node ${process.version}): node's own readFileSync is no untrackable read`, !loader.untrackable)
ok('loader: it is filed as a read of the file', loader.read)
ok(`import (node ${process.version}): a dynamic import is no untrackable read`, !run('import').untrackable)
ok('foreign-fd: a read through a descriptor never seen opened is untrackable', run('foreign-fd').untrackable)
ok('write-open: an open for writing is untrackable', run('write-open').untrackable)

const fstat = run('fstat')

ok('fstat: an fstat of a read-only descriptor is no untrackable read', !fstat.untrackable)
ok('fstat: its open is filed as a read', fstat.read)

console.log(failed === 0 ? 'PASS' : `FAIL ${failed}`)
process.exit(failed === 0 ? 0 : 1)
