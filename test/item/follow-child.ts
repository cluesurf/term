// A run that follows a child process (code/output.ts `followChild`), for test/item/unit.ts to watch from outside: the
// child writes a JSON log line, a logfmt line and a plain line, on both streams, and the test reads what this process
// printed. Usage: npx tsx test/item/follow-child.ts [--raw]

import { spawn } from 'node:child_process'
import { closeRun, followChild, openRun, setOutput } from '@term/call/code/output'

setOutput({ raw: process.argv.includes('--raw') }, '2.5.24')
openRun({ verb: 'boot', root: process.cwd() })

const script = [
  `console.log(JSON.stringify({ level: 'error', logger: 'database', msg: 'Connection lost', host: 'db1' }))`,
  `console.error('level=warn module=smtp msg="slow to respond" duration=3000')`,
  `console.log('listening on 4000')`,
].join(';')

const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
followChild(child, 'server')
child.on('close', () => {
  // the streams' last lines are read before `close`, so the run closes after every one of them
  setTimeout(() => closeRun({ verdict: 'Stopped' }), 20)
})
