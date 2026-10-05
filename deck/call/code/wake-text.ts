// What `term wake` writes, as text, with no imports. deck/deck/test/scaffold.test.ts holds it against the formatter
// and the manifest rules, and runs in the @term/deck package, which cannot resolve @term/call: reading these from
// wake.ts, which prints through the output library, stopped that test from loading at all (2026-10-04).

// no `test ./test`: nothing reads it, `term test` finds `test/` on its own, and `term lint` warns on it (L055)
export const DECK_TREE = (project: string): string => `deck ${project}
  mark <0.0.1>
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

export const README = (project: string): string => `# ${project}

A Term project.

## Develop

\`\`\`
term boot     # compile and run
term feed     # dev server with hot reload
term test     # run tests
term make     # build
\`\`\`
`

// Everything under `.base/` can be rebuilt but the memory, which a person wrote, so the memory is the one part kept:
// git cannot re-include a file whose folder is ignored, hence one rule per level. `.base/` whole kept the facts on
// the machine that wrote them (guides: commands/mind, 2026-10-04). A project made before 2026-10-05 has the same rules
// for `.base/@cluesurf/term`, which home.ts `renameIgnoreRules` renames when it moves that folder
export const GITIGNORE = `host
link
.base/*
!.base/@term/
.base/@term/*
!.base/@term/code/
.base/@term/code/*
!.base/@term/code/memory/
node_modules
`
