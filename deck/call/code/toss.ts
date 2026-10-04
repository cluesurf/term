// `term toss <deck>`: remove a dependency from the manifest. Prints through the terminal output library
// (code/output.ts).

import { removeDependency } from '@cluesurf/deck.tree'
import { closeRun, openRun, report } from '@term/call/code/output'

export async function callToss(input: {
  root: string
  deck?: string
}): Promise<void> {
  openRun({ verb: 'toss', root: input.root })

  if (!input.deck) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck to remove' })
    closeRun({ verdict: 'Nothing removed', next: 'term toss <deck>', failure: 'usage' })

    return
  }

  try {
    await removeDependency({
      root: input.root,
      name: input.deck,
    })
    report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: input.deck })
    closeRun({ verdict: `Removed ${input.deck}` })
  } catch (err) {
    report({ glyph: 'failed', verb: 'remove', subject: input.deck, message: [err instanceof Error ? err.message : String(err)] })
    closeRun({ verdict: `${input.deck} was not removed` })
  }
}
