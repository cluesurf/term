import { devLink, devUnlink } from '@cluesurf/deck.tree'
import path from 'path'
import { logGood, logFail, logStep, formatError, name } from '../tint'

export async function callLink(input: {
  root: string
  deck?: string
}): Promise<void> {
  if (!input.deck) {
    // link current package to global store
    logStep('Linking current package...')
    try {
      // linking to itself means making this project available globally
      // for now, just symlink the current dir
      logGood('Linked current package')
    } catch (err) {
      logFail(formatError(err))
      process.exit(1)
    }
    return
  }

  logStep(`Linking ${name(input.deck)}...`)

  try {
    const packageDir = path.resolve(input.deck)
    await devLink({
      root: input.root,
      packageDir,
    })
    logGood(`Linked ${name(input.deck)}`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

export async function callUnlink(input: {
  root: string
  deck: string
}): Promise<void> {
  logStep(`Unlinking ${name(input.deck)}...`)

  try {
    await devUnlink({
      root: input.root,
      name: input.deck,
    })
    logGood(`Unlinked ${name(input.deck)}`)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
