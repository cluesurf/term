// `term load`: install the project's dependencies. Prints through the terminal output library (code/output.ts).

import { install } from '@cluesurf/deck.tree'
import { closeRun, count, openRun, report } from '@term/call/code/output'

export async function callLoad(input: {
  root: string
  clean?: boolean
  offline?: boolean
}): Promise<void> {
  const facts = [...(input.clean ? ['--clean'] : []), ...(input.offline ? ['--offline'] : [])]
  openRun({ verb: 'load', root: input.root, facts })
  const started = Date.now()

  try {
    const installed = await install({
      root: input.root,
      clean: input.clean,
      offline: input.offline,
    })
    report({ glyph: 'done', verb: 'install', subject: 'Dependencies', duration: Date.now() - started, counts: [count(installed.decks, 'decks', 'deck')] })
    closeRun({ verdict: 'Dependencies installed' })
  } catch (err) {
    // an install that fails (a registry, a constraint, the network) is the user's environment, exit 1, not a bug
    report({ glyph: 'failed', verb: 'install', subject: 'Dependencies', duration: Date.now() - started, message: [messageOf(err)] })
    closeRun({ verdict: 'Dependencies not installed' })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
