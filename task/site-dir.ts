// Where a tool writes the term.surf public files (the installer, the apt and dnf indexes) and reads the loader script:
// `--site <dir>`, else TERM_SITE_DIR, else host/site/ under the Term root. The site is not part of this repository, so
// a tool never reaches for it by a path of its own: the person's alias names it. A path the person typed resolves
// against the folder they typed it in (INIT_CWD, which pnpm sets), never the Term root a script runs from.

import path from 'node:path'

/** The folder a path option names, `--<flag> <dir>`, else the environment variable, else `fallback` */
export function givenDir(input: { flag: string; variable: string; fallback: string }): string {
  const argv = process.argv
  const at = argv.indexOf(input.flag)
  const typed = at === -1 ? undefined : argv[at + 1]

  if (at !== -1 && !typed) {
    throw new Error(`${input.flag} needs a folder`)
  }

  const given = typed ?? process.env[input.variable]?.trim()

  return given ? path.resolve(process.env.INIT_CWD ?? process.cwd(), given) : input.fallback
}

/** The term.surf public folder: `--site <dir>`, else TERM_SITE_DIR, else host/site/ under `term` */
export function siteDir(term: string): string {
  return givenDir({ flag: '--site', variable: 'TERM_SITE_DIR', fallback: path.join(term, 'host', 'site') })
}
