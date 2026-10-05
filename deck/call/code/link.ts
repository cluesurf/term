// `term link` and its undo: use a working copy of a package instead of a published one. Prints through the terminal
// output library (code/output.ts): a `link` (or `unlink`) run, one item for what was done, and a closing verdict.
//
// An error from the package manager here is the user's to fix (a name that is not registered, a folder that is not a
// package), so it ends the run as a ✗ item and exit 1, never as a bug in Term.

import {
  devLink,
  devUnlink,
  registerGlobalLink,
  consumeGlobalLink,
} from '@cluesurf/deck.tree'
import { lstatSync } from 'fs'
import fsp from 'fs/promises'
import path from 'path'
import { closeRun, field, openRun, report, showPath } from '@term/call/code/output'

// whether anything is at a path, a link that points nowhere included
function lstatOrNothing(file: string): boolean {
  try {
    lstatSync(file)

    return true
  } catch {
    return false
  }
}

// a refusal from the package manager: its message as a ✗ item, then the closing item
function refused(error: unknown, verdict: string): void {
  report({ glyph: 'failed', kind: 'problem', subject: error instanceof Error ? error.message : String(error) })
  closeRun({ verdict })
}

export async function callLink(input: {
  root: string
  deck?: string
}): Promise<void> {
  // no argument: register the current package in the global link registry (~/.base/@cluesurf/term/link), so any project can later
  // `term link <name>` to use this working copy.
  if (!input.deck) {
    openRun({ verb: 'link', root: input.root, facts: ['global'] })

    try {
      const fullName = await registerGlobalLink({
        packageDir: input.root,
      })
      report({ glyph: 'added', kind: 'change', verb: 'add', subject: fullName, facts: ['global link'] })
      closeRun({ verdict: `${fullName} is registered`, next: `term link ${fullName}, in the project that uses it`, done: true })
    } catch (error) {
      refused(error, 'Not registered')
    }

    return
  }

  openRun({ verb: 'link', root: input.root, facts: [input.deck] })

  try {
    // first try the global registry by name (the npm-link consume step)
    const consumed = await consumeGlobalLink({
      root: input.root,
      name: input.deck,
    })

    if (consumed) {
      report({ glyph: 'added', kind: 'change', verb: 'add', subject: input.deck, facts: ['from the global registry'] })
      closeRun({ verdict: `${input.deck} is linked`, done: true })

      return
    }

    // otherwise treat the argument as a path to a local package
    const packageDir = path.resolve(input.deck)

    try {
      await fsp.access(path.join(packageDir, 'deck.tree'))
    } catch {
      report({
        glyph: 'failed',
        kind: 'problem',
        subject: `${input.deck} is not in the global link registry and is not a local package`,
        fields: [field('looked', showPath(path.join(packageDir, 'deck.tree')))],
      })
      closeRun({ verdict: 'Not linked', next: `term link, inside ${input.deck}, to register it` })

      return
    }

    await devLink({
      root: input.root,
      packageDir,
    })
    report({ glyph: 'added', kind: 'change', verb: 'add', subject: input.deck, facts: [showPath(packageDir)] })
    closeRun({ verdict: `${input.deck} is linked`, done: true })
  } catch (error) {
    refused(error, 'Not linked')
  }
}

export async function callUnlink(input: {
  root: string
  deck: string
}): Promise<void> {
  openRun({ verb: 'unlink', root: input.root, facts: input.deck ? [input.deck] : [] })

  if (!input.deck) {
    report({ glyph: 'failed', kind: 'problem', subject: 'Name the deck to unlink' })
    closeRun({ verdict: 'Nothing unlinked', next: 'term link --toss <deck>', failure: 'usage' })

    return
  }

  // a name with no link is said to have none, not reported as unlinked
  const linked = path.join(input.root, 'link', ...input.deck.split('/'))

  if (!lstatOrNothing(linked)) {
    report({ glyph: 'failed', kind: 'problem', subject: `There is no link named ${input.deck}`, fields: [field('looked', showPath(linked, input.root))] })
    closeRun({ verdict: 'Nothing unlinked' })

    return
  }

  try {
    await devUnlink({
      root: input.root,
      name: input.deck,
    })
    report({ glyph: 'removed', kind: 'change', verb: 'remove', subject: input.deck, facts: ['link'] })
    closeRun({ verdict: `${input.deck} is unlinked`, done: true })
  } catch (error) {
    refused(error, 'Not unlinked')
  }
}
