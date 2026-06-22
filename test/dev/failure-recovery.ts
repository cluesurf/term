// HMR failure recovery: a recompile error shows an overlay and keeps the app running on its last-good code (no
// reload, so state survives), and the next good update clears the overlay. Run: npx tsx test/dev/failure-recovery.ts

import { applyHmr } from '@cluesurf/make/code/dev/client'
import type { HmrEnvironment } from '@cluesurf/make/code/dev/client'

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

async function main(): Promise<void> {
  let shown: string[] | undefined
  let cleared = false
  let reloaded = false

  const env: HmrEnvironment = {
    reload: () => {
      reloaded = true
    },
    reimport: async () => ({}),
    acceptOf: () => undefined,
    log: () => {},
    showError: errors => {
      shown = errors
    },
    clearError: () => {
      cleared = true
    },
  }

  // a recompile error: overlay shown, NO reload (the running app keeps its state)
  await applyHmr(
    { type: 'error', errors: ['type mismatch on line 7'] },
    env,
  )
  ok(
    'an error shows the overlay',
    shown?.[0] === 'type mismatch on line 7',
  )
  ok('an error does NOT reload (state is preserved)', !reloaded)

  // the next good update clears the overlay
  await applyHmr({ type: 'update', updates: [] }, env)
  ok('a good update clears the error overlay', cleared)

  console.log(`\nfailure-recovery: ${pass} pass, ${fail} fail`)
}

void main()
