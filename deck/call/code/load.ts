import { install } from '@cluesurf/deck.tree'
import {
  logGood,
  logFail,
  logStep,
  formatError,
} from '@term/make/code/tint'

export async function callLoad(input: {
  root: string
  clean?: boolean
  offline?: boolean
  like?: string
}): Promise<void> {
  logStep('Installing dependencies...')

  try {
    await install({
      root: input.root,
      clean: input.clean,
      offline: input.offline,
    })
    logGood('Dependencies installed')
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
