// Write one master key, tone-packed, to the file named on the command line.
//
//   pnpm exec tsx test/make-key.ts /somewhere/key
//
// TO A FILE, NOT TO STDOUT. `pnpm exec` writes its own lines to stdout
// ("Already up to date", "Done in 141ms"), so a `| tail -1` around it can
// pick up a pnpm status line instead of the key. That yields a string that
// unpacks to the wrong number of bytes, and it surfaces as a stack trace out
// of SubtleCrypto.importKey with nothing pointing back here.
import './shim'
import { writeFileSync } from 'node:fs'

const { makeKey } = await import('../host/code/seal/base')
const { tonePack } = await import('../host/link/@term/seed/code/tone')

const out = process.argv[2]

if (!out) {
  process.stderr.write('make-key: needs a path to write the key to\n')
  process.exit(1)
}

writeFileSync(out, tonePack(await makeKey()), { mode: 0o600 })
