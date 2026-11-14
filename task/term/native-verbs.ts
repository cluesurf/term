// THE VERBS THE NATIVE TERM FORWARDS (07-the-binary.md "Forwarding, during the transition", item
// term-self-host-001-0161 requirement 4): the command line of every route the native build hands to the node build,
// one per line, then the count. Read from the build's own record, host/native/build.json, which `pnpm make:native`
// writes from what the lowering emitted, never from a list somebody keeps. A verb leaves this list in the change that
// makes its closure native (decision 109 rule 2).
//
//   pnpm term:native-verbs
//
// Exit 0 with the list, 2 when the native term has not been built.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NativeRecord } from './native-build'
import { TERM_ROOT } from './root'

const RECORD = join(TERM_ROOT, 'host', 'native', 'build.json')

if (!existsSync(RECORD)) {
  console.error('term:native-verbs: there is no native build record (host/native/build.json): run pnpm make:native')
  process.exit(2)
}

const record = JSON.parse(readFileSync(RECORD, 'utf8')) as NativeRecord
for (const line of record.forwarded) console.log(line)
console.log('')
console.log(`${record.forwarded.length} forwarded, ${record.nativeTasks.length} native verbs beside --help and --version (${record.entry}, ${record.bytes} bytes, --version ${record.version})`)
