import { publishDeck, makeDefaultFetchConfig } from '@cluesurf/deck.tree'
import { logGood, logFail, logStep, formatError } from '../tint'

export async function callHost(input: {
  root: string
  dryRun?: boolean
}): Promise<void> {
  logStep(input.dryRun ? 'Dry-run publish...' : 'Publishing...')

  try {
    await publishDeck({
      dir: input.root,
      config: makeDefaultFetchConfig(),
      dryRun: input.dryRun ?? false,
    })
    if (!input.dryRun) {
      logGood('Published successfully')
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
