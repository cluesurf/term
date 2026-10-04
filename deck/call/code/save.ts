// `term save <deck>`: add a dependency to the manifest. Prints through the terminal output library (code/output.ts).

import { addDependency } from '@cluesurf/deck.tree'
import { closeRun, openRun, report } from '@term/call/code/output'

export async function callSave(input: {
  root: string
  deck?: string
  constraint?: string
}): Promise<void> {
  openRun({ verb: 'save', root: input.root })

  if (!input.deck) {
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck to add' })
    closeRun({ verdict: 'Nothing added', next: 'term save <deck>', failure: 'usage' })

    return
  }

  try {
    await addDependency({
      root: input.root,
      name: input.deck,
      constraint: input.constraint,
    })
    report({ glyph: 'added', kind: 'change', verb: 'add', subject: input.deck, facts: input.constraint ? [input.constraint] : [] })
    closeRun({ verdict: `Added ${input.deck}` })
  } catch (err) {
    report({ glyph: 'failed', verb: 'add', subject: input.deck, message: [err instanceof Error ? err.message : String(err)] })
    closeRun({ verdict: `${input.deck} was not added` })
  }
}
