// `seed wake [name]`: scaffold a new Seed project. Creates a deck.tree manifest, a starter entry module, a readme, and
// a .gitignore. With a name it makes a new directory; without one it scaffolds the current directory (if empty).

import fsp from 'fs/promises'
import path from 'path'
import {
  logGood,
  logFail,
  logStep,
  fade,
  name as tintName,
} from '@cluesurf/make/code/tint'

const DECK_TREE = (project: string): string => `deck ${project}
  bear ./code
  test ./test
  mark <0.0.1>
  boot ./code/boot
`

const BOOT_TREE = `# The application entry point. \`seed boot\` compiles and runs this module's \`boot\` task.

load @cluesurf/seed/code/console
  find log

task boot
  note async
  call log
    text <hello from seed>
`

const README = (project: string): string => `# ${project}

A Seed project.

## Develop

\`\`\`
seed boot     # compile and run
seed feed     # dev server with hot reload
seed test     # run tests
seed make     # build
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
  const label = project && project !== '.' ? project : path.basename(target)

  logStep(`Waking ${tintName(label)}...`)

  try {
    await fsp.mkdir(target, { recursive: true })

    const existing = await fsp.readdir(target)

    if (existing.includes('deck.tree')) {
      logFail(`A deck.tree already exists in ${target}`)
      process.exit(1)
    }

    await fsp.mkdir(path.join(target, 'code'), { recursive: true })
    await fsp.mkdir(path.join(target, 'test'), { recursive: true })

    await Promise.all([
      fsp.writeFile(path.join(target, 'deck.tree'), DECK_TREE(label)),
      fsp.writeFile(path.join(target, 'code', 'boot.tree'), BOOT_TREE),
      fsp.writeFile(path.join(target, 'readme.md'), README(label)),
      fsp.writeFile(path.join(target, '.gitignore'), GITIGNORE),
    ])

    logGood(`Woke ${tintName(label)}`)
    console.log(
      fade(
        project && project !== '.'
          ? `  cd ${project} && seed boot`
          : `  seed boot`,
      ),
    )
  } catch (error) {
    logFail(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
