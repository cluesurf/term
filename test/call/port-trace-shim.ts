// The trace's fs shim (task/port-trace/code/runtime/fs-trace.ts, with task/port-trace/code/trace.tree) files a
// read-only `openSync` of a path as a read of it, and reads through that descriptor as nothing it cannot describe (item
// term-self-host-001-1041, decision 140 section 3). From node 23 the ESM loader under tsx's synchronous hooks loads a
// module's source with node's ORIGINAL `readFileSync`, which opens and reads through the `fs` module object, so its
// `openSync` and `readSync` reached the trace at depth 0. They marked the process untrackable, and port-build, which
// loads stage0 through that loader, skipped no module on node 24. Each case runs in its own process
// (task/port-trace/probe.tree, run by the launcher), since an untrackable read is sticky for the rest of one.
//
//   loader      node's original readFileSync of a Buffer: filed as a read of the file, not untrackable
//   import      a dynamic import of a module under the trace (on node 24 the loader's own path): not untrackable
//   foreign-fd  a readSync through a descriptor the trace never saw opened: untrackable
//   write-open  an openSync for writing: untrackable
//   fstat       an fstatSync of a read-only descriptor: not untrackable
//
// The cases of test/call/port-trace-descriptor.ts, which holds task/port-trace.ts until it retires.
//
//   npx tsx test/call/port-trace-shim.ts      (from deck/term/deck/term)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../temp'

const TERM = join(import.meta.dirname, '..', '..')

let failed = 0

function ok(name: string, cond: boolean, info = ''): void {
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name}${cond || !info ? '' : `: ${info}`}`)

  if (!cond) {
    failed++
  }
}

const dir = fs.realpathSync(tempDir('term-port-trace-descriptor-'))

fs.writeFileSync(join(dir, 'data.txt'), 'some content\n')
fs.writeFileSync(join(dir, 'probe.mjs'), 'export const probe = 1\n')

function run(name: string): { untrackable: boolean; read: boolean } {
  const out = execFileSync(process.execPath, [join(TERM, 'task', 'launch.mjs'), 'port-trace/probe', name, dir], { cwd: TERM, encoding: 'utf8' })

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
