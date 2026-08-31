import {
  devLink,
  devUnlink,
  registerGlobalLink,
  consumeGlobalLink,
} from '@cluesurf/deck.tree'
import fsp from 'fs/promises'
import path from 'path'
import {
  logGood,
  logFail,
  logStep,
  fade,
  formatError,
  name,
} from '@term/make/code/tint'

export async function callLink(input: {
  root: string
  deck?: string
}): Promise<void> {
  // no argument: register the current package in the global link registry (~/.base/@cluesurf/term/link), so any project can later
  // `term link <name>` to use this working copy.
  if (!input.deck) {
    logStep('Registering current package globally...')

    try {
      const fullName = await registerGlobalLink({
        packageDir: input.root,
      })
      logGood(`Registered ${name(fullName)}`)
      console.log(
        fade(`  use it elsewhere with: term link ${fullName}`),
      )
    } catch (error) {
      logFail(formatError(error))
      process.exit(1)
    }

    return
  }

  logStep(`Linking ${name(input.deck)}...`)

  try {
    // first try the global registry by name (the npm-link consume step)
    const consumed = await consumeGlobalLink({
      root: input.root,
      name: input.deck,
    })

    if (consumed) {
      logGood(`Linked ${name(input.deck)}`)

      return
    }

    // otherwise treat the argument as a path to a local package
    const packageDir = path.resolve(input.deck)

    try {
      await fsp.access(path.join(packageDir, 'deck.tree'))
    } catch {
      logFail(
        `"${input.deck}" is not in the global link registry and is not a local package (no deck.tree at ${packageDir})`,
      )
      process.exit(1)
    }

    await devLink({
      root: input.root,
      packageDir,
    })
    logGood(`Linked ${name(input.deck)}`)
  } catch (error) {
    logFail(formatError(error))
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
  } catch (error) {
    logFail(formatError(error))
    process.exit(1)
  }
}
