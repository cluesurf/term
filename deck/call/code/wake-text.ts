// What `term wake` writes, as text. deck/deck/test/scaffold.test.ts holds it against the formatter and the manifest
// rules. The texts are Term since 2026-10-06, call/code/wake-files.tree; this face keeps them as the constants wake.ts
// and the test read. It imports nothing that prints: reading these from wake.ts, which prints through the output
// library, stopped that test from loading at all (2026-10-04).

import * as port from '@term/call/code/wake-files'

export const DECK_TREE = (project: string): string => port.deckTree(project)

export const BOOT_TREE = port.bootTree()

export const README = (project: string): string => port.readme(project)

export const GITIGNORE = port.gitignore()
