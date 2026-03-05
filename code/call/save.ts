import { addDependency } from '@cluesurf/deck.tree'
import { logGood, logFail, logStep, formatError, name } from '../tint'

export async function callSave(input: {
  root: string
  deck?: string
  constraint?: string
}): Promise<void> {
  if (!input.deck) {
    logFail('Missing deck name. Usage: seed save <deck>')
    process.exit(1)
  }

  logStep(`Adding ${name(input.deck)}...`)

  try {
    await addDependency({
      root: input.root,
      name: input.deck,
      constraint: input.constraint,
    })
    logGood(`Added ${name(input.deck)}`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
