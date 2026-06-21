import { removeDependency } from '@cluesurf/deck.tree'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  name,
} from '@cluesurf/make/code/tint'

export async function callToss(input: {
  root: string
  deck?: string
}): Promise<void> {
  if (!input.deck) {
    logFail('Missing deck name. Usage: seed toss <deck>')
    process.exit(1)
  }

  logStep(`Removing ${name(input.deck)}...`)

  try {
    await removeDependency({
      root: input.root,
      name: input.deck,
    })
    logGood(`Removed ${name(input.deck)}`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
