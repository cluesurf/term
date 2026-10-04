// `term wake [name]`: scaffold a new Term project. Creates a deck.tree manifest, a starter entry module, a readme,
// and a .gitignore. With a name it makes a new directory; without one it scaffolds the current directory (if empty).
//
// WHAT IT SCAFFOLDS HAS TO BE CLEAN, because it is the first Term anyone reads. It said `seed` throughout (the
// language was renamed), imported `@term/base` (the legacy prefix, which resolves but is not the name any more),
// and its entry comment was 87 characters, so a new project failed `term lint` on the line the scaffold itself
// wrote. test/call/lifecycle.ts runs `wake` then `lint` and holds it.
//
// Three more, found writing the getting-started guide on 2026-10-02, all held by the same test:
//
// - Every file is written in `term form`'s canonical layout, so `term form --check` passes on a project nobody has
//   touched yet. The entry's comment sits directly above its `load` and the one-argument `call log` is on one line,
//   because that is what the formatter prints. The manifest stays stacked because the formatter now keeps `deck`
//   stacked (deck/make/code/format/format.ts, ALWAYS_STACK), which is how writeManifest writes it too.
// - The version starts at 0.0.1, and `term move mark` goes 0.0.1 -> 0.0.2. Which numbers an author publishes is
//   their own convention: the toolchain holds none.
// - The version is `mark <0.0.1>`, and no `code` line is written: `code ./code` names the code root, which is the
//   default, and the scaffold's sources are under ./code. The `bear ./code` it used to write was the old spelling
//   of that same default (note/term/plan/manifest-mark-and-code-root.md). The entry loads `@term/base/console`,
//   the short form a package path takes now that it resolves inside the package's code root first.
// - The name is the user's, UNSCOPED (`deck hello`). The manifest grammar accepts it, `term make` reads it as the
//   manifest (deck/call/code/manifest-name.ts), and `term host` asks for a scope only when it is about to publish.
//   Inventing one here (`@hello/hello`) would put a registry decision in a file before anyone has made it.

import fsp from 'fs/promises'
import path from 'path'
import { closeRun, count, field, openRun, report, showPath } from '@term/call/code/output'

// exported so deck/deck/test/scaffold.test.ts can hold the text itself against the formatter and the manifest rules
export const DECK_TREE = (project: string): string => `deck ${project}
  mark <0.0.1>
  test ./test
  boot ./code/boot
`

export const BOOT_TREE = `# The application entry point. \`term boot\` compiles and runs
# this module's \`boot\` task.
load @term/base/console
  find log

task boot
  mark async
  log <hello from term>
`

const README = (project: string): string => `# ${project}

A Term project.

## Develop

\`\`\`
term boot     # compile and run
term feed     # dev server with hot reload
term test     # run tests
term make     # build
\`\`\`
`

const GITIGNORE = `host
link
.base/
node_modules
`

export async function callWake(input: {
  root: string
  name?: string
}): Promise<void> {
  const project = input.name?.trim()
  const target =
    project && project !== '.'
      ? path.resolve(input.root, project)
      : input.root
  // the deck's name is the folder's own name, never the path that reached it: `term wake ~/work/demo` names it `demo`
  const label = path.basename(target)

  openRun({ verb: 'wake', root: input.root, subject: showPath(target) })

  try {
    await fsp.mkdir(target, { recursive: true })

    const existing = await fsp.readdir(target)

    if (existing.includes('deck.tree')) {
      report({ glyph: 'failed', kind: 'problem', subject: 'A deck.tree is already here', fields: [field('at', `${showPath(target)}/deck.tree`)] })
      closeRun({ verdict: 'Nothing written' })

      return
    }

    await fsp.mkdir(path.join(target, 'code'), { recursive: true })
    await fsp.mkdir(path.join(target, 'test'), { recursive: true })

    const written: [string, string][] = [
      ['deck.tree', DECK_TREE(label)],
      ['code/boot.tree', BOOT_TREE],
      ['readme.md', README(label)],
      ['.gitignore', GITIGNORE],
    ]

    await Promise.all(written.map(([file, text]) => fsp.writeFile(path.join(target, file), text)))

    // one `add` change item per file written, in the order a reader opens them
    for (const [file] of written) {
      report({ glyph: 'added', kind: 'change', verb: 'add', subject: file })
    }

    closeRun({
      verdict: `${label} is ready`,
      counts: [count(written.length, 'files', 'file')],
      next: project && project !== '.' ? `cd ${project} && term boot` : 'term boot',
      done: true,
    })
  } catch (error) {
    report({ glyph: 'failed', kind: 'problem', subject: 'The project could not be written', message: [error instanceof Error ? error.message : String(error)] })
    closeRun({ verdict: 'Nothing written' })
  }
}
