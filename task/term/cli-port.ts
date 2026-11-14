// The CLI port gate: does each module converted to Term answer exactly what the TypeScript it replaces answers?
//
// `cli-in-term` rewrites `deck/call/code/*.ts` as Term. A rewrite is only safe if it can be held against the
// original, so every converted module gets a case here comparing the two IMPLEMENTATIONS on real input, not their
// shapes. `pnpm term:cli-drift` does the same for the command surface; this does it for the code behind it.
//
// THE SHIMS ARE INSTALLED BY HAND, and that is not incidental. A module emitted under `host/**` assumes the
// natives it calls are already global (`io`, `path`), because `term boot` PREPENDS them to the bundle. Importing
// one directly skips that step and the first native call dies with `ReferenceError: io is not defined` pointing at
// emitted code rather than at the missing setup. A shim is concatenated, not imported: it declares `const io = {...}`
// at top level, so importing the file does nothing at all. deck/zone/test/shim.ts solves it the same way.
//
// Run from the repository root: `pnpm term:cli-port`. Reports by default and writes nothing.
// Design: note/project/term/cli-in-term/readme.md.

import { readFileSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { PARENT_ROOT, TERM_ROOT, parentRoot } from './root'

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const CALL = join(TERM, 'deck/call')

// where a package lives: inside the Term tree, except zone, which moved to the repository's deck/zone on 2026-10-02
// and is still the best real tree for the walk and the manifest reader to be held against
function packageDir(pkg: string): string {
  return pkg === 'zone' ? join(parentRoot(), 'deck/zone') : join(TERM, 'deck', pkg)
}

// the globals `term boot` prepends, for the natives the ported modules reach
// (`environment` since the wash verb reads its project root from the working directory, work/home.tree `root`)
// (`env-variable` since 0011's wash opens an output run, whose readVariables reaches base/environment `has-variable`
// and so the `<global:env-variable>` dock: without it the wash row died 'envVariable is not defined', 0242).
// A shim's file is kebab-case and its global the camelCase of it (env-variable.ts declares `const envVariable`).
const SHIMS = ['io', 'path', 'regex', 'environment', 'env-variable']

function installShims(): void {
  const require_ = createRequire(join(TERM, 'x.js'))

  for (const file_ of SHIMS) {
    const name = file_.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const file = join(
      TERM,
      'deck/base/code/native/node/runtime',
      `${file_}.ts`,
    )

    try {
      const source = readFileSync(file, 'utf8')
      const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code
      const make = new Function(
        'require',
        'module',
        'exports',
        `${js}; return typeof ${name} !== 'undefined' ? ${name} : undefined`,
      ) as (r: unknown, m: unknown, e: unknown) => unknown

      ;(globalThis as Record<string, unknown>)[name] = make(
        require_,
        { exports: {} },
        {},
      )
    } catch (cause) {
      console.log(`  could not install the ${name} shim: ${String(cause)}`)
    }
  }
}

let pass = 0
let fail = 0

function same(name: string, a: unknown, b: unknown): void {
  const left = JSON.stringify(a)
  const right = JSON.stringify(b)

  if (left === right) {
    pass++
    console.log(`ok    ${name}`)
  } else if (Array.isArray(a) && Array.isArray(b)) {
    // two LISTS print only where they differ: a full 800-file listing buried the one file that disagreed
    fail++
    const onlyTerm = a.filter(item => !b.some(other => JSON.stringify(other) === JSON.stringify(item)))
    const onlyTs = b.filter(item => !a.some(other => JSON.stringify(other) === JSON.stringify(item)))
    console.log(
      `FAIL  ${name} (term ${a.length}, ts ${b.length})\n        only term: ${JSON.stringify(onlyTerm.slice(0, 10))}\n        only ts:   ${JSON.stringify(onlyTs.slice(0, 10))}`,
    )
  } else {
    fail++
    console.log(`FAIL  ${name}\n        term: ${left}\n        ts:   ${right}`)
  }
}

async function main(): Promise<void> {
  installShims()

  // ---- home: the on-disk path and environment names ----
  const home = (await import(
    join(CALL, 'host/code/work/home.ts')
  )) as Record<string, (...args: string[]) => string>
  const homeTs = (await import(join(CALL, 'code/home.ts'))) as Record<
    string,
    (...args: string[]) => string
  >
  const root = '/tmp/a-project'

  same('home/projectHome', home.projectHome?.(root), homeTs.projectHome?.(root))
  same(
    'home/legacyProjectHome',
    home.legacyProjectHome?.(root),
    homeTs.legacyProjectHome?.(root),
  )
  same('home/userHome', home.userHome?.(), homeTs.userHome?.())
  same(
    'home/legacyUserHome',
    home.legacyUserHome?.(),
    homeTs.legacyUserHome?.(),
  )

  // ---- files: which `.tree` files a command acts on ----
  const files = (await import(join(CALL, 'host/code/work/files.ts'))) as {
    walkTrees: (root: string) => Promise<string[]>
  }
  const filesTs = (await import(join(CALL, 'code/files.ts'))) as {
    collectTreeFiles: (paths: string[], root: string) => Promise<string[]>
  }

  // real packages, not a fixture: the walk's whole job is the shelving rules, and only a real tree has drafts,
  // `draft.tree` directories, linked dependencies and build output in it
  for (const pkg of ['call', 'base', ...(PARENT_ROOT ? ['zone'] : []), 'site', 'mill']) {
    const dir = join(packageDir(pkg), 'code')
    const want = await filesTs.collectTreeFiles([], dir)
    const got = (await files.walkTrees(dir)).slice().sort()

    same(`files/${pkg} (${want.length} files)`, got, want)
  }

  // ---- test-text: the `test` preprocessor's text helpers ----
  //
  // Held against EXPECTED VALUES rather than against the TypeScript, because `test-preprocess.ts` keeps these
  // helpers private and exports only `preprocessTests`. The values are the ones its own regexes produce.
  const testText = (await import(
    join(CALL, 'host/code/work/test-text.ts')
  )) as Record<string, (...args: string[]) => unknown>

  const expected: [string, unknown, unknown][] = [
    ['indent of four', testText.indentOf?.('    x'), 4],
    ['indent of none', testText.indentOf?.('x'), 0],
    ['blank is blank', testText.isBlank?.('   '), true],
    ['a word is not blank', testText.isBlank?.(' a '), false],
    ['slugify a phrase', testText.slugify?.('Hello There!'), 'hello-there'],
    ['slugify pure punctuation', testText.slugify?.('!!!'), 'case'],
    ['a phrase names a slug', testText.nameSlug?.('<a phrase here>'), 'a-phrase-here'],
    ['a bare name is its own slug', testText.nameSlug?.('bare-name'), 'bare-name'],
    ['a phrase labels itself', testText.nameLabel?.('<a phrase here>'), 'a phrase here'],
    ['a bare name labels with spaces', testText.nameLabel?.('bare-name'), 'bare name'],
  ]

  for (const [name, got, want] of expected) {
    same(`test-text/${name}`, got, want)
  }

  // ---- wash: removing a project's build artifacts ----
  //
  // Run for real against a temporary tree, both implementations, and compare what survives. `wash` is destructive,
  // so a check that only reads its source would prove nothing about the thing that matters.
  // since term-cli-in-term-0011 the verb is `wash(target)` alone: it reads the project root from the working directory
  // and hands the clean to callWash (work/wash.tree), so `washBuild` is gone and the port is run as the hook runs it,
  // in the project, with no target
  const wash = (await import(join(CALL, 'host/code/work/wash.ts'))) as {
    wash: (target: string) => Promise<void>
  }
  // the original's reference copy, byte equal to the retired deck/call/code/wash.ts (term-cli-in-term-0226)
  const washTs = (await import(join(TERM, 'tmp/retired/call/wash-small.ts'))) as {
    callWash: (input: { root: string; target?: string }) => Promise<void>
  }

  const survivors = async (run: (root: string) => Promise<void>) => {
    const dir = mkdtempSync(join(tmpdir(), 'term-wash-'))

    for (const made of [
      'host',
      'make',
      'hold',
      '.base/@term/code/cache',
      '.base/@cluesurf/term/cache',
      '.base/term/cache',
      'code',
    ]) {
      mkdirSync(join(dir, made), { recursive: true })
    }

    // a project: `callWash` refuses a folder without one since 2026-10-04, because `make/` and `hold/` are ordinary
    // folder names anywhere else
    writeFileSync(join(dir, 'deck.tree'), 'deck @probe/wash\n  mark <0.0.1>\n')

    await run(dir)

    return readdirSync(dir).sort()
  }

  same(
    'wash/what survives a clean',
    await survivors(async root => {
      const back = process.cwd()

      process.chdir(root)

      try {
        await wash.wash('')
      } finally {
        process.chdir(back)
      }
    }),
    await survivors(async root => {
      await washTs.callWash({ root })
    }),
  )

  // ---- manifest: what a deck.tree declares, read with the real parser ----
  const manifest = (await import(
    join(CALL, 'host/code/work/manifest.ts')
  )) as { manifestValue: (text: string, file: string, head: string) => string }
  const manifestTs = (await import(join(CALL, 'code/manifest-name.ts'))) as {
    manifestValue: (
      text: string,
      file: string,
      head: string,
    ) => string | undefined
  }

  // real manifests, including this package's own, which declares `role ./role` as a CHILD of `deck` -- the case a
  // top-level-only reader silently missed
  for (const pkg of ['call', 'base', 'site', ...(PARENT_ROOT ? ['zone'] : [])]) {
    const file = join(packageDir(pkg), 'deck.tree')

    let text: string

    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }

    for (const head of ['deck', 'code', 'lock', 'role', 'head']) {
      same(
        `manifest/${pkg} ${head}`,
        manifest.manifestValue(text, file, head),
        manifestTs.manifestValue(text, file, head) ?? '',
      )
    }
  }

  // ---- dispatch: an argv resolved against the real command tree ----
  //
  // Against the REAL tree, not a fixture: the whole job is descending subcommands and stopping flag parsing at a
  // variadic's child command line, and only the shipped 47-command tree has both in it.
  const dispatch = (await import(
    join(CALL, 'host/code/work/dispatch.ts')
  )) as {
    commandPath: (routes: unknown[], argv: string[]) => string[]
    routeFor: (routes: unknown[], argv: string[]) => unknown
    taskFor: (route: unknown) => string
  }
  // the Term dispatcher's parse (work/hook/parsing.tree's port, term-cli-in-term-0225)
  const hook = (await import(join(CALL, 'host/port/code/work/hook/parsing.ts'))) as {
    commandRoutes: (program: unknown) => unknown[]
    programOf: (routes: unknown[]) => { commands: unknown[] }
  }
  const compile = (
    await import(join(TERM, 'deck/make/code/compile/compile.ts'))
  ).compile as (
    source: { file: string; text: string },
    options?: unknown,
  ) => { ok: boolean; program?: unknown; diagnostics?: { message: string; span?: { file?: string; line?: number } }[] }
  const { projectResolver } = (await import(join(CALL, 'code/make.ts'))) as {
    projectResolver: (root: string) => unknown
  }

  // the role and the lean surface, as `term make` reads them: the tree's closure reaches the lean verbs in work/
  const roles = (await import(join(CALL, 'code/role-of.ts'))) as {
    projectRoleOf: (root: string) => (file: string) => string | null | undefined
    projectLeanOf: (root: string) => (file: string) => boolean
  }
  const treeFile = join(CALL, 'code/line/base.tree')
  const built = compile(
    {
      file: treeFile,
      text: readFileSync(treeFile, 'utf8'),
    },
    { resolve: projectResolver(CALL), roleOf: roles.projectRoleOf(CALL), leanOf: roles.projectLeanOf(CALL) },
  )

  if (built.ok && built.program) {
    // the commands are the program hook's nested hooks (decision term/003 part 3)
    const routes = hook.programOf(hook.commandRoutes(built.program)).commands

    const expect: [string[], string, string][] = [
      // `hook make` binds line/base.tree's wrapper `make-project`, which takes make's options (cli-in-term-0011)
      [['make'], 'make', 'make-project'],
      [['self', 'list'], 'self list', 'self-list'],
      [['base', 'log'], '', ''],
      [['seek', '--format', 'json'], 'seek', 'seek'],
      [['zone', 'call', 'npm', 'run', 'dev'], 'zone', 'zone'],
      [['wash', 'tail'], 'wash', 'wash'],
      [['nope'], '', ''],
    ]

    for (const [argv, path, task] of expect) {
      const route = dispatch.routeFor(routes, argv)

      same(
        `dispatch/${argv.join(' ')}`,
        // `route-for` answers a `maybe` ({ form: 'some', value } or { form: 'none' }), never a nullable route
        [dispatch.commandPath(routes, argv).join(' '), route.form === 'some' ? dispatch.taskFor(route.value) : ''],
        [path, task],
      )
    }
  } else {
    // a gate that skips its section in silence passes what it never checked: the refusal is a failure, named
    fail++
    console.log('FAIL  dispatch: the command tree did not compile, so dispatch was not checked')

    for (const one of (built.diagnostics ?? []).slice(0, 5)) {
      console.log(`      ${one.span?.file ?? ''}:${one.span?.line ?? ''} ${one.message}`)
    }
  }

  console.log('')
  console.log(`cli-port: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main().catch((cause: unknown) => {
  console.error(cause)
  process.exitCode = 1
})
