import { spawn } from 'child_process'
import { cpus } from 'node:os'
import path from 'path'
import {
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  watch as fsWatch,
} from 'fs'
import {
  compile,
  isLookStylesheet,
} from '@term/make/code/compile/compile'
import { compileSeparate } from '@term/make/code/compile/separate'
import type { SeparateResult, UnitExplain, UnitMemo } from '@term/make/code/compile/separate'
import { hashText } from '@term/make/code/term/hash'
import { staleEntries } from '@term/make/code/compile/reach'
import { isDataFile } from '@term/make/code/compile/host'
import { toCamel, toPascal } from '@term/make/code/compile/typescript'
import { CompileCache } from '@term/make/code/compile/cache'
import { makeParseMemo } from '@term/make/code/compile/load'
import { projectCache, projectCacheDir } from '@term/call/code/cache-store'
import { readable } from '@term/call/code/test-preprocess'
import { isLockfileAt, isRoleFileAt, manifestNameOf } from '@term/call/code/manifest-name'
import { projectDeckOf } from '@term/call/code/deck-of'
import type { DeckOf } from '@term/make/code/compile/roll'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import { parse } from '@term/make/code/parser/tree'
import {
  compileFeedMine,
  feedMineFaults,
  feedMineLoads,
  feedMineSubstrate,
  readFeedMineGrammar,
} from '@term/make/code/compile/feed-mill'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import type { LoadHow, ParseMemo, Resolver, Source, WalkMemo } from '@term/make/code/compile/load'
// from the compiler, where they live, not through call/code/walk.ts's re-export: walk.ts imports esbuild (for the
// REPL), and the language server imports `projectResolver` from here into a bundle that ships no node_modules
import {
  stdlibResolver,
  linkResolver,
  siblingResolver,
  resolvePackagePath,
} from '@term/make/code/resolve'
import { packageRest } from '@term/make/code/deck/resolve'
import { renderDiagnostic } from '@term/call/code/report'
import { declaresDraft } from '@term/call/code/draft'
import { FACE_NATIVE_PATH, contractFindings } from '@term/call/code/face-contract'
import type { ContractFinding } from '@term/call/code/face-contract'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { addOwed, describeOwed } from '@term/make/code/check/holds'
import type { Owed } from '@term/make/code/check/holds'
import { closeRun, count, failRun, field, openRun, outputOptions, report, reportProblems } from '@term/call/code/output'

// one problem of a build, whole: the diagnostic, and the text it was compiled from when that is not the file on disk
// (the test preprocessor rewrote it, or it is a generated grammar reader), so its code frame shows the right lines
export type BuildProblem = { diagnostic: Diagnostic; text?: string }

// every .tree file under a directory, skipping generated output and dependency / vcs folders
// the per-platform native trees. A build targets ONE of these, and `withNativeEnv` rewrites every abstract
// `.../native/<name>` import to the concrete `.../native/<platform>/<name>`, so the other platforms' sources are
// never reachable from it. Compiling them anyway means reporting errors for code the target will never run, and for
// platforms that cannot be tested from here.
const NATIVE_PLATFORMS = [
  'node',
  'browser',
  'cloudflare',
  'webview',
  'rust',
  'swift',
  'javascript',
  'kotlin',
]

// does this file declare itself unfinished? A top-level `mark draft` line anywhere in it (call/code/draft.ts)
function isDraftTree(file: string): boolean {
  try {
    return declaresDraft(readFileSync(file, 'utf8'))
  } catch {
    return false
  }
}

// is this file a package MANIFEST (a top-level `deck <name>` statement, scoped or not), as opposed to a code module
// that merely shares the name? Parsed, never matched: deck/base/code/deck.tree is a module, and telling them apart by
// filename skipped the entire stdlib. Unscoped counts: `term wake hello` writes `deck hello`, and requiring an `@`
// compiled that manifest as code into host/deck.ts.
function isPackageManifest(file: string): boolean {
  return existsSync(file) && manifestNameOf(file) !== undefined
}

// The cursor library a generated reader reads through. Every dialect grammar in the tree is a FEED dialect and
// reads a `@term/feed` cursor, so this is where `make-text-cursor`, `read-byte` and the rest come from. A grammar
// that one day needs another cursor library will say so in the grammar, which is where a fact about a dialect
// belongs. Until one does, inventing the syntax for it would be inventing a requirement.
const FEED_CURSOR = '@term/feed/code/base'

// Is this file a feed GRAMMAR (a `mine.tree` that reads to rules), as opposed to Term code? Parsed, never matched
// on its name, for the same reason `deck.tree` is: a filename is a guess about content and this codebase has been
// burnt by one (a filename test for the package manifest skipped the entire stdlib).
//
// The grammar comes back with it, because reading a mine.tree twice is reading it twice. `undefined` means this is
// not a grammar and the ordinary code path should have it: a 0-byte `mine.tree` placeholder, or a file that
// happens to be called that and is not one.
//
// `faults` are the leaf rules that read to nothing (`feedMineFaults`), which the build refuses: a reader generated
// without one stops checking that position, which is wrong output rather than missing output.
function feedGrammarOf(
  file: string,
  text: string,
): { grammar: ReturnType<typeof readFeedMineGrammar>; faults: string[] } | undefined {
  if (path.basename(file) !== 'mine.tree') {
    return undefined
  }

  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const grammar = readFeedMineGrammar(parsed.tree)

  return grammar.size > 0
    ? { grammar, faults: feedMineFaults(parsed.tree) }
    : undefined
}

// One file as the build compiles it. A feed grammar is the reader generated from it (`generated`), or the faults
// that stop one being generated. A file of `test` blocks is its rewritten text, and `place` moves a diagnostic back
// onto the lines as written. Anything else is its own text. `term make`, `roll`, `hold` and `time` all compile
// through this, so no command reads a file differently from the build: `term roll` compiled a `mine.tree` as plain
// Term and printed `unknown-name` for every word of every grammar (guides: parsers/grammars, 2026-10-04).
//
// A `mine.tree` is a GRAMMAR, not Term code. The build generates the reader it describes and compiles THAT, so a
// dialect is written once, as the grammar, instead of twice as a grammar and a hand-written reader that drifts from
// it. Which is the whole point of feed-mill: the two cannot disagree if there is only one.
//
// The SUBSTRATE is inferred, never asked for. `byte`, `int` and `bytes` can only read a byte cursor and `char`,
// `text`, `range` and `span` can only read a text one, and across @term/feed's readable grammars six are
// byte-only, eight text-only, and none use both. A grammar with no leaf to infer from is REPORTED rather than
// guessed at: guessing would emit a reader that compiles and reads the wrong cursor.
//
// A `mine.tree` under the `mill` role is a MILL grammar, checked as itself (compile/mill-check.ts), never a feed
// grammar, so `role` is the file's role as the build reads it.
export function buildable(
  file: string,
  source: string,
  role?: string | null,
):
  | { text: string; generated: boolean; place: (diagnostic: Diagnostic) => BuildProblem }
  | { faults: string[] } {
  const read = role === 'mill' ? undefined : feedGrammarOf(file, source)

  if (read && read.faults.length > 0) {
    return { faults: read.faults }
  }

  if (read) {
    const substrate = feedMineSubstrate(read.grammar)

    if (!substrate) {
      return {
        faults: [
          'cannot tell whether this grammar reads bytes or text. ' +
            'Every rule in it is a combinator over rules with no body, so there is no leaf to infer from. ' +
            'Write one of its leaf rules, or shelve the grammar with `mark draft` until it has one.',
        ],
      }
    }

    // the grammar's own `load` blocks come through verbatim: a `mine value` may call a real helper, and where that
    // helper lives is a fact only the grammar knows. Its diagnostics are framed against the generated reader, the
    // only text they have lines in
    const generated = compileFeedMine(read.grammar, substrate, FEED_CURSOR, feedMineLoads(file, source))

    return { text: generated, generated: true, place: diagnostic => ({ diagnostic, text: generated }) }
  }

  const unit = readable(source)

  return { text: unit.text, generated: false, place: unit.place }
}

export function findTreeFiles(
  dir: string,
  out: string[] = [],
  // the platform being built for; when given, other platforms' native trees are skipped. `shared` is always kept,
  // since it belongs to every target.
  platform?: string,
  // the package root the walk started from, so a folder that means something only at the root is told apart
  root: string = dir,
): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  const parent = path.basename(dir)

  for (const entry of entries) {
    if (
      entry === 'node_modules' ||
      entry === 'host' ||
      entry === '.git'
    ) {
      continue
    }

    // NOTHING HERE IS THIS PACKAGE'S SOURCE, and the walk used to descend into all of it and throw it away after.
    // Measured on the Term root, 2026-10-05: 29.6 s in `tmp/` (44,848 scratch `.tree` files tests and benchmarks
    // write) and 7.8 s in `link/` (5,206 files of installed dependencies), against 0.4 s for the 157 files that are
    // the package. The language server lists a package for every workspace symbol search, so one search held the
    // editor's queue for 46 s and a save waited behind it ("Getting code actions from 'Term'").
    //
    //   a hidden folder   `.base` (Term's caches), `.build` and `.swiftpm` (Swift's), never source
    //   tmp               scratch, gitignored by house rule
    //   link at the root  the installed dependencies, reached through the resolver like any other package, and not
    //                     compiled as this one's files (the same reason a nested package is skipped below). ONLY at
    //                     the root: `deck/mill/code/code/form/link` is the grammar of the `link` head, real source
    if (
      entry.startsWith('.') ||
      entry === 'tmp' ||
      (entry === 'link' && dir === root)
    ) {
      continue
    }

    if (
      platform &&
      parent === 'native' &&
      entry !== platform &&
      entry !== 'shared' &&
      NATIVE_PLATFORMS.includes(entry)
    ) {
      continue
    }

    const full = path.join(dir, entry)
    // a link to nothing (a `link/` entry whose deck was removed) is not a file of this build. It stopped the whole
    // walk with a bare ENOENT before a file was read; a load of it is now refused at the load, `unresolved-load`
    // (guides: packages/install, 2026-10-04)
    const stat = (() => {
      try {
        return statSync(full)
      } catch {
        return undefined
      }
    })()

    if (!stat) {
      continue
    }

    if (stat.isDirectory()) {
      // a whole module can be shelved at once: a `draft.tree` in a directory takes that directory and everything
      // under it out of the build, so an unfinished subtree is declared in one place instead of per file
      if (existsSync(path.join(full, 'draft.tree'))) {
        continue
      }

      // a subdirectory holding its own package MANIFEST is a DIFFERENT package, and builds itself. Compiling its
      // sources into this one resolves its imports against the wrong root: the blog sample app in deck/site/test/site
      // declares `deck @term/blog` and loads `@term/site/...`, which is a foreign package from there and needs a
      // `link/` entry, so every one of its imports came back undefined and site's build reported five phantom unknown
      // names. The same files compile clean from the term root, which is how test/site/{serve,router,blog}.ts build.
      //
      // It has to be a MANIFEST, not merely a file called deck.tree. The stdlib has a code module at
      // deck/base/code/deck.tree (`load ./text ...`, the manifest's own shape as Term), so a filename test skipped
      // the whole of deck/base/code — 803 files, the entire stdlib — and the build cheerfully reported success on
      // the 20 that were left. manifestNameOf parses it and answers only for a real top-level `deck <name>`.
      if (isPackageManifest(path.join(full, 'deck.tree'))) {
        continue
      }

      findTreeFiles(full, out, platform, root)
    } else if (entry.endsWith('.tree')) {
      // a package MANIFEST is read by the package manager and is not Term code. Compiling one emitted an empty
      // module that nothing imports, and only ever produced misleading errors: a manifest head the code mill does not
      // know (`boot`, `back`, `hook`, `face`, `book` in test/site/deck.tree) was reported as an undefined NAME. A
      // root manifest happened to compile clean because its heads (`deck`, `load`, `bear`) are also code heads, so
      // the rule looked like it worked. The manifest grammar is checked where it is read, not here.
      //
      // Again: MANIFEST, not filename. deck/base/code/deck.tree is an ordinary stdlib module.
      if (entry === 'deck.tree' && isPackageManifest(full)) {
        continue
      }

      // a ROLE FILE says which mill reads which file (and what a `hook` in it means). Configuration, read through
      // the role mill, not a program: `role` is not a code statement, so compiling one reports `the name "role"
      // is not defined` on a file nobody wrote as code. Content, not filename: this package's own is
      // `role/base.tree`.
      if (isRoleFileAt(full)) {
        continue
      }

      // the LOCKFILE is data the package manager writes, not Term code. `lock <1>` is not a statement, so before
      // this a project failed to build with `the name "lock" is not defined` the moment any dependency verb ran.
      // Content, not filename: deck/base/code/task/lock.tree is an ordinary module.
      if (entry === 'lock.tree' && isLockfileAt(full)) {
        continue
      }

      // a file that declares `mark draft` is unfinished and is not built. This keeps a half-written module in the
      // tree, readable and version-controlled, without its errors drowning the ones that matter. Remove the line to
      // bring it back into the build.
      if (isDraftTree(full)) {
        continue
      }

      out.push(full)
    }
  }

  return out
}

// the on-disk file a bare module path points at, applying Seed's candidate order (`foo.tree`, then `foo/base.tree`,
// then `foo/note.tree`). Returns the first that exists, else undefined. Shared by the build resolver and `term boot`.
export function resolveTreeFile(base: string): string | undefined {
  for (const candidate of [
    `${base}.tree`,
    path.join(base, 'base.tree'),
    path.join(base, 'note.tree'),
  ]) {
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return undefined
}

// the resolver a project build uses: the bundled stdlib (`@cluesurf/base/...`) plus the project's own `.tree` files,
// wrapped so abstract native imports resolve to the target platform's implementation (default node)
// realpath if it exists, else a normalized absolute path (so confinement
// checks work for not-yet-existing candidates too).
// The real path of `p`, resolving symlinks along however much of it EXISTS.
//
// `realpathSync` throws on a path that is not there, and the obvious fallback (return it unresolved) is wrong in a
// way that does not announce itself: the confinement check below compares a candidate against its package root,
// the package root always exists and so is always resolved, and the candidate is a bare `.../code` with no
// extension yet and so never is. On any project whose path crosses a symlink the two are then spelled
// differently — `/var/folders/...` against `/private/var/folders/...`, which is EVERY macOS temporary directory —
// the candidate reads as outside its own package, the import resolves to nothing, and the failure surfaces much
// later and somewhere else as `the name "x" is not defined`, pointing at the call and never at the import.
//
// So resolve the longest ancestor that does exist and re-attach the rest. A path with no existing ancestor at all
// falls back to `path.resolve`, which is the same answer as before for a case where there is nothing to resolve.
function safeReal(p: string): string {
  const full = path.resolve(p)
  let dir = full
  const rest: string[] = []

  for (;;) {
    try {
      return rest.length > 0 ? path.join(realpathSync(dir), ...rest) : realpathSync(dir)
    } catch {
      const up = path.dirname(dir)

      if (up === dir) {
        return full
      }

      rest.unshift(path.basename(dir))
      dir = up
    }
  }
}

// is `child` inside `parent` (or equal to it)? compared on normalized paths.
function isWithin(child: string, parent: string): boolean {
  if (child === parent) {return true}

  const rel = path.relative(parent, child)

  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

// What a separate build learns that the next one may keep (`compileProjectSeparate`): the unit answers, each module's
// walk, each load's answer, each module's parse, and each entry's outcome. A watch keeps one for its life
// (note/term/plan/incremental-best-in-class.md, steps 2 and 3). A module's walk and parse are checked against its text
// and a load's answer against its file's stamp, so an edit is seen wherever it lands. What a stamp cannot see is a
// file appearing where a load found nothing, or a manifest or role file changing how every module is read, so either
// of those starts the session over
export type BuildSession = {
  resolve: Resolver
  parsed: ParseMemo
  units: UnitMemo
  walked: WalkMemo
  // what each entry built to, the last time it built
  entries: Map<string, EntryOutcome>
  // starts a build of `files` and answers which files moved since the last one, of every module that build walked.
  // `undefined` when nothing may be replayed: the session's first build, or one that started it over
  turn: (files: string[]) => string[] | undefined
  // ends a build: the stamp of every module it walked, which the next build's `turn` compares against
  close: () => void
}

// an entry's build, as much of it as the next build needs to replay it: its own problems, its open claims, its
// obligations, and how many units it reached. Its artifacts are already on disk, written when it was built
export type EntryOutcome = {
  problems: BuildProblem[]
  open: string[]
  obligations: Parameters<typeof addOwed>[1]
  units: number
  closureKey: string
}

export function buildSession(root: string): BuildSession {
  let kept = keptResolver(projectResolver(root))
  const walked: WalkMemo = new Map()
  const entries = new Map<string, EntryOutcome>()
  // each walked module's stamp as of the last build
  const stamps = new Map<string, string>()
  // the files that say how every module is read, rather than being one
  const settings = ['deck.tree', 'lock.tree', 'role.tree', 'base/role.tree'].map(name => path.join(root, name))
  let known: string | undefined

  return {
    resolve: (importPath, fromFile, how) => kept.resolve(importPath, fromFile, how),
    parsed: makeParseMemo(),
    units: new Map(),
    walked,
    entries,
    turn: files => {
      kept.turn()

      const listed = files.join('\n')
      const moved = [...stamps].filter(([file, stamp]) => kept.stamp(file) !== stamp).map(([file]) => file)

      if (listed === known && !moved.some(file => settings.includes(file))) {
        return moved
      }

      // the session's first build: nothing it holds can be stale yet (a parallel pass may have walked for it already),
      // but no entry has an outcome to replay
      if (known === undefined) {
        known = listed

        return undefined
      }

      known = listed
      kept = keptResolver(projectResolver(root))
      walked.clear()
      entries.clear()
      stamps.clear()

      return undefined
    },
    close: () => {
      for (const file of [...walked.keys(), ...settings]) {
        stamps.set(file, kept.stamp(file))
      }
    },
  }
}

// What `term make --explain` keeps (note/term/plan/incremental-best-in-class.md, step 6): the inputs each unit was last
// built from, one file per unit under the project's cache, written only when the unit is built. It sits beside the
// cache rather than in it, because the cache's directories are per compiler version, and "the compiler changed" is
// one of the things it has to be able to say
export function explainStore(root: string): UnitExplain {
  const dir = path.join(projectCacheDir(root), 'explain')
  const fileOf = (id: string): string => path.join(dir, `${hashText(id)}.json`)

  return {
    reasons: new Map(),
    recall: id => {
      try {
        const kept = JSON.parse(readFileSync(fileOf(id), 'utf8')) as {
          compiler: string
          own: [string, string][]
          read?: [string, string][]
          settings: string
          names: [string, string][]
        }

        return {
          compiler: kept.compiler,
          own: new Map(kept.own),
          read: new Map(kept.read ?? []),
          settings: kept.settings,
          names: new Map(kept.names),
        }
      } catch {
        return undefined
      }
    },
    remember: (id, inputs) => {
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(
          fileOf(id),
          JSON.stringify({
            compiler: inputs.compiler,
            own: [...inputs.own],
            read: [...inputs.read],
            settings: inputs.settings,
            names: [...inputs.names],
          }),
        )
      } catch {
        // an explanation is never worth failing a build over
      }
    },
  }
}

// A resolver whose answers outlive one build. An answer is a file AND its text. WHICH file a load lands on changes only
// when a file appears or disappears, which starts a session over (`buildSession`), so that half is kept. The text is
// kept with the stamp (size and modification time) it was read at, and the first time a build hands a file out its
// stamp is asked again: a file that moved is read again. Never asked of `base` again, because `base` keeps what it
// read for its own life (`projectResolver`'s read cache) and would hand back the old text, which is how the first
// version of this served an edited module as it was (task/term/edit-replay.ts found it on its first run). A later ask
// in the same build is a map lookup. `turn` starts a build
export function keptResolver(base: Resolver): { resolve: Resolver; turn: () => void; stamp: (file: string) => string } {
  const answers = new Map<string, Source | undefined>()
  // each file handed out, the text it was handed out with and the stamp that text was read at
  const texts = new Map<string, { stamp: string; text: string }>()
  const stamps = new Map<string, string>()

  const stampOf = (file: string): string => {
    const known = stamps.get(file)

    if (known !== undefined) {
      return known
    }

    let stamp = 'missing'

    try {
      const stat = statSync(file)
      stamp = `${stat.size}:${stat.mtimeMs}`
    } catch {
      stamp = 'missing'
    }

    stamps.set(file, stamp)

    return stamp
  }

  // `found` with its file's text as it is now
  const current = (found: Source): Source => {
    const now = stampOf(found.file)
    let had = texts.get(found.file)

    if (had === undefined) {
      had = { stamp: now, text: found.text }
      texts.set(found.file, had)
    } else if (had.stamp !== now) {
      try {
        had = { stamp: now, text: readFileSync(found.file, 'utf8') }
        texts.set(found.file, had)
      } catch {
        // gone: the session starts over at its next build, when the file list no longer holds it
        return found
      }
    }

    return had.text === found.text ? found : { ...found, text: had.text }
  }

  const resolve: Resolver = (importPath, fromFile, how) => {
    const key = `${importPath}\u0000${fromFile}\u0000${how?.base ?? ''}`
    let found: Source | undefined

    if (answers.has(key)) {
      found = answers.get(key)
    } else {
      found = base(importPath, fromFile, how)
      answers.set(key, found)
    }

    if (found === undefined) {
      return undefined
    }

    const now = current(found)

    // kept as handed out, so an unchanged file is the same object every build
    if (now !== found) {
      answers.set(key, now)
    }

    return now
  }

  return { resolve, turn: () => stamps.clear(), stamp: stampOf }
}

// A resolver that answers each (load, file it is in, `base`) once for the life of one build. Every entry's import walk
// asks the same questions of the same modules, and the project resolver answers each one on the filesystem: on
// @term/bind, 3,091 entries each walking the standard library, that walk was 42 s of a 147 s warm build
// (2026-10-05). Files do not change during a build, so the answer does not either. A watch makes one per rebuild
export function buildResolver(base: Resolver): Resolver {
  const answers = new Map<string, Source | undefined>()

  return (importPath, fromFile, how) => {
    const key = `${importPath}\u0000${fromFile}\u0000${how?.base ?? ''}`

    if (answers.has(key)) {
      return answers.get(key)
    }

    const found = base(importPath, fromFile, how)
    answers.set(key, found)

    return found
  }
}

export function projectResolver(
  root: string,
  env: NativeEnv = 'node',
  // an optional second `link/` root tried after the project's own. The CLI passes its own install dir here, so an app
  // that has not run `term link` itself still resolves `@cluesurf/*` through the seed install's stdlib links.
  fallbackLinkRoot?: string,
): Resolver {
  const stdlib = stdlibResolver()
  const sibling = siblingResolver()
  const linked = linkResolver(root)
  const fallbackLinked =
    fallbackLinkRoot && fallbackLinkRoot !== root
      ? linkResolver(fallbackLinkRoot)
      : undefined

  // a per-resolver read cache keyed by the on-disk candidate path. A shared
  // dependency is imported by many modules, so without this it is read once
  // PER importer (a tiny file pulling in the stdlib re-read ~24MB for ~2MB of
  // unique source). Files do not change during a compile, so caching reads for
  // the resolver's lifetime is safe and eliminates the redundant IO.
  const readCache = new Map<string, Source | undefined>()

  const tryFile = (b: string) => {
    const candidate = resolveTreeFile(b)

    return candidate ? readFile(candidate) : undefined
  }

  const readFile = (candidate: string): Source | undefined => {
    const cached = readCache.get(candidate)

    if (cached !== undefined || readCache.has(candidate)) {
      return cached
    }

    // canonicalize so a file reached via a symlink (e.g. a self-referencing linked package) dedups to one module.
    // guard the read: a candidate that turns out to be a directory or is otherwise unreadable is "not found", never a
    // thrown EISDIR/EACCES that would crash the compiler on a malformed import.
    let result: Source | undefined

    try {
      result = {
        file: realpathSync(candidate),
        text: readFileSync(candidate, 'utf8'),
      }
    } catch {
      result = undefined
    }

    readCache.set(candidate, result)

    return result
  }

  // the package boundary of a file: the nearest ancestor holding a
  // `deck.tree` manifest, else the project root. A relative import may not
  // escape this boundary - that confinement is what stops a malicious
  // `load ../../../../etc/passwd` from reading arbitrary files during a
  // compile of untrusted source (path-traversal / info-disclosure).
  const rootReal = safeReal(root)

  // asked once per import (the memo key of a package path carries it), so remembered per directory
  const packageRootCache = new Map<string, string>()

  const packageRootOf = (file: string): string => {
    const start = path.dirname(file)
    const known = packageRootCache.get(start)

    if (known !== undefined) {
      return known
    }

    let dir = start
    let found = rootReal

    for (;;) {
      if (existsSync(path.join(dir, 'deck.tree'))) {
        found = safeReal(dir)
        break
      }

      const up = path.dirname(dir)

      if (up === dir) {
        break
      }

      dir = up
    }

    packageRootCache.set(start, found)

    return found
  }

  // the package NAME of a file, read from the `deck @scope/name` line of its nearest `deck.tree`. This makes `@/sub/path`
  // a LOCAL-PACKAGE alias: it expands to `@scope/name/sub/path`, so a module refers to its own package without naming it,
  // and each sub-package in a monorepo resolves `@/x` relative to its own nearest manifest.
  const packageNameCache = new Map<string, string | undefined>()

  const packageNameOf = (file: string): string | undefined => {
    const dir = packageRootOf(file)
    const cached = packageNameCache.get(dir)

    if (cached !== undefined || packageNameCache.has(dir)) {
      return cached
    }

    let name: string | undefined

    name = manifestNameOf(path.join(dir, 'deck.tree'))

    packageNameCache.set(dir, name)

    return name
  }

  // memoize the WHOLE resolution (candidate probing + read). An absolute
  // `@scope/...` import resolves the same regardless of the importing file, so
  // it is keyed by the path alone and shared across all importers; a relative
  // import is keyed by the path plus the importer's directory. This collapses
  // the thousands of repeated resolutions of shared stdlib modules into one
  // each (the existsSync candidate-probing was the cost once reads were cached).
  const resolveMemo = new Map<string, Source | undefined>()

  const base: Resolver = (rawImportPath, fromFile, how) => {
    // `@/sub/path` is the local-package alias: expand to `<this-package>/sub/path` from the importer's manifest name,
    // before memoization, so the memo key and downstream resolution use the concrete `@scope/name/...` path. Each
    // sub-package in a monorepo resolves `@/x` against its own nearest deck.tree.
    let importPath = rawImportPath

    if (importPath.startsWith('@/')) {
      const pkg = packageNameOf(fromFile)

      if (!pkg) {
        return undefined
      }

      importPath = `${pkg}/${importPath.slice(2)}`
    }

    const relative =
      importPath.startsWith('./') || importPath.startsWith('../')

    // a `base` is part of the question: the same path asked from the package root is a different file. A package
    // path resolves the same from every importer EXCEPT through the own-package and project fallbacks, which read
    // the importer's package, so those are keyed by it too
    const memoKey =
      (relative ? `${path.dirname(fromFile)}\0${importPath}` : `${packageRootOf(fromFile)}\0${importPath}`) +
      (how?.base !== undefined ? `\0base:${how.base}` : '')

    const memoHit = resolveMemo.get(memoKey)

    if (memoHit !== undefined || resolveMemo.has(memoKey)) {
      return memoHit
    }

    const result = resolveUncached(importPath, fromFile, relative, how)
    resolveMemo.set(memoKey, result)

    return result
  }

  // a package path inside one package directory, by THE rule (code root, then package root, or `base`)
  const inPackage = (dir: string, rest: string, how?: LoadHow): Source | undefined => {
    const { file, shadowed } = resolvePackagePath({ dir, rest, base: how?.base })
    const source = file ? readFile(file) : undefined

    // the read is cached and shared, so the shadow is reported on a copy of it
    return source && shadowed ? { ...source, shadowed } : source
  }

  const resolveUncached = (
    importPath: string,
    fromFile: string,
    relative: boolean,
    how?: LoadHow,
  ): Source | undefined => {
    // a relative import resolves against the importing file (the framework's modules import each other this way).
    // `base` names a folder of a PACKAGE and means nothing here, so a relative load carrying one names nothing
    if (relative) {
      if (how?.base !== undefined) {
        return undefined
      }

      const resolved = path.resolve(path.dirname(fromFile), importPath)
      // confine: the resolved file must stay within the importer's package
      // (or the project root). Anything escaping both is treated as
      // not-found rather than read off the host filesystem.
      const bound = packageRootOf(fromFile)
      const resolvedReal = safeReal(resolved)

      if (
        !isWithin(resolvedReal, bound) &&
        !isWithin(resolvedReal, rootReal)
      ) {
        return undefined
      }

      return tryFile(resolved)
    }

    // linked packages first (@cluesurf/base, /bind, /term, /site via `term link`): the project's own links, then the
    // CLI install's links, then the bundled stdlib fallback
    const fromLink =
      linked(importPath, fromFile, how) ??
      fallbackLinked?.(importPath, fromFile, how)

    if (fromLink) {
      return fromLink
    }

    const fromStdlib = stdlib?.(importPath, fromFile, how)

    if (fromStdlib) {
      return fromStdlib
    }

    // any other package in the same tree as the stdlib, by name and without a `link/` entry. After the link dir, so
    // a project that genuinely links its own copy of a package still wins. See siblingResolver.
    const fromSibling = sibling?.(importPath, fromFile, how)

    if (fromSibling) {
      return fromSibling
    }

    const named = packageRest(importPath)

    if (!named) {
      return undefined
    }

    // the importer's OWN package, by its declared name. A package that imports itself has no `link/` entry
    // pointing at itself and should not need one: @term/bind does this 11,503 times and @term/site 5, and every one
    // of them once silently resolved to nothing, so the imported names existed but could not be used.
    const ownPackage = packageNameOf(fromFile)

    if (ownPackage && named.pkg === ownPackage) {
      const withinSelf = inPackage(packageRootOf(fromFile) ?? root, named.rest, how)

      if (withinSelf) {
        return withinSelf
      }
    }

    // `@scope/pkg/sub/path` against the project being built, when nothing else claims the name: the project's code
    // root, then its root, by the same rule
    return inPackage(rootReal, named.rest, how)
  }

  // AN APP SHADOWS A FACE IMPLEMENTATION (native-dom-0025): an import of `@term/face/code/component/native/...` first
  // tries the SAME RELATIVE PATH in the project being built, then face's own. It sits under withNativeEnv, so it applies
  // per rung of the env chain: an app's `code/component/native/toolkit/switch.tree` wins over face's toolkit switch on
  // macOS, iOS and Android, and face's generic still serves the web. No flag, prop or platform check in the component.
  // Building face itself, the project's file IS face's, so nothing changes. note/term/app/11-uniform-interface.md
  // Either spelling of the path reaches it: `@term/face/component/native/...` (the code root, the short form) and
  // the older `@term/face/code/component/native/...`, and the app's file is found by the package path rule.
  const FACE_NATIVE = ['@term/face/component/native/', '@term/face/code/component/native/']
  const rootFace = path.join(rootReal, 'deck.tree')

  const shadowed: Resolver = (importPath, fromFile, how) => {
    if (
      how?.base === undefined &&
      FACE_NATIVE.some(prefix => importPath.startsWith(prefix)) &&
      existsSync(rootFace) &&
      manifestNameOf(rootFace) !== '@term/face'
    ) {
      const own = inPackage(rootReal, importPath.slice('@term/face/'.length))

      if (own) {
        return own
      }
    }

    return base(importPath, fromFile, how)
  }

  return withNativeEnv(env, shadowed)
}

// compile every .tree file in the project to TypeScript under `host/`, mirroring the source tree. An optional shared
// cache makes repeated builds (watch mode) incremental: an unchanged module reuses its parse + mill. An artifact is
// only WRITTEN when its content actually changed, so a rebuild touches just the files whose output differs (no redundant
// I/O, and tools watching `host/` are not woken for nothing). Returns counts plus rich, colored diagnostic frames so the
// caller decides how to report and whether to fail.
export function compileProject(
  root: string,
  cache: CompileCache = projectCache(root),
  // the platform this build targets; other platforms' native trees are not compiled. Matches the resolver default.
  platform = 'node',
): {
  compiled: number
  written: number
  failed: number
  errors: string[]
  // each file's own warnings, rendered: an unused binding (a misspelled `save` is one), termination, and the rest.
  // The build computed them and printed none, so `save totl` beside `save total` built in silence (guides:
  // language/variables, 2026-10-03). A warning never fails the build
  warnings: string[]
  // the claims this project states that nobody has proven: every `rule` carrying `mark open`. Reported on the
  // build line so an open claim is visible rather than silent. See note/term/project/law-proof-gate.md.
  open: string[]
  // tier 0 over the project's own tasks: obligations written and proven. `term hold` holds the rest to hold.json.
  obligations: Owed
  // the same errors and warnings as `errors` and `warnings`, whole, for the terminal output library to draw as
  // Problem items with their code frames (code/output.ts). `text` is the compiled text when it is not the file
  problems: BuildProblem[]
  // a failure with no diagnostic behind it: a grammar that cannot be read, a shadow that breaks face's contract
  faults: string[]
} {
  const files = findTreeFiles(root, [], platform)
  const obligations: Owed = { total: 0, proven: 0 }
  const resolve = buildResolver(projectResolver(root))
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  // `mark lean` on a role rule, read off the same role files: which units take the lean surface
  const leanOf = projectLeanOf(root)
  // ONE PARSE MEMO FOR THE WHOLE PROJECT, not one per file. Every entry walks its import closure to work out its
  // cache key, and that walk runs before the cache can be asked, so a memo per entry re-parses the stdlib for every
  // file in the project. See makeParseMemo in compile/load.ts.
  const parsed = makeParseMemo()
  // and one walk per module, however many entries reach it (compile/load.ts `WalkMemo`)
  const walked: WalkMemo = new Map()

  let compiled = 0
  let written = 0
  let failed = 0

  const open = new Set<string>()
  const errors: string[] = []
  const warnings: string[] = []
  const problems: BuildProblem[] = []
  const faults: string[] = []

  for (const file of files) {
    // a file carrying `test <phrase>` blocks is not plain Term until the test preprocessor has rewritten them into
    // tasks. `term test` does that before compiling; a plain build has to as well, or every test file in the project
    // fails here on a construct the compiler is never meant to see.
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit) {
      failed++

      for (const fault of unit.faults) {
        errors.push(`${path.relative(root, file)}: ${fault}`)
        faults.push(`${path.relative(root, file)}: ${fault}`)
      }

      continue
    }

    const { text, generated: grammar } = unit

    // a problem in this file, framed against what the person wrote
    const framed = (diagnostic: Diagnostic): BuildProblem =>
      diagnostic.file !== file ? { diagnostic, text: undefined } : unit.place(diagnostic)

    const result = compile(
      { file, text },
      // leanOf beside roleOf: a unit's role rule may carry `mark lean`, and the mill has to be told. Left out
      // here on 2026-09-12 while compileSeparate had it, so `term make` read every lean grammar long-form and
      // reported every property head as an unknown name.
      { resolve, cache, parsed, walked, deckOf, roleOf, leanOf },
    )

    if (!result.ok) {
      failed++

      // render each diagnostic as a rich, colored source frame (header + locator + caret), reusing the in-memory text
      // for diagnostics in this file and reading imported modules from disk.
      for (const problem of result.diagnostics.map(framed)) {
        errors.push(renderDiagnostic(problem.diagnostic, problem.text))
        problems.push(problem)
      }

      continue
    }

    compiled++

    // only this file's: every entry's program holds its whole import closure, and the stdlib's warnings would be
    // printed once per file that loads it. A grammar's own compile is of the reader generated from it, whose capture
    // names the generator chose (a rule answers its last capture, so each is bound): an unused one is about code the
    // author never wrote, and it was printed at a line of the generated source, `mine.tree:37` in a 20-line grammar
    // (guides: parsers/grammars, 2026-10-04)
    for (const warning of result.warnings) {
      if (warning.file === file && !(grammar && warning.name === 'unused-binding')) {
        const problem = framed(warning)
        warnings.push(renderDiagnostic(problem.diagnostic, problem.text))
        problems.push(problem)
      }
    }

    for (const claim of result.openClaims ?? []) {
      open.add(claim)
    }

    addOwed(obligations, result.obligations)

    // a mill definition (the `mill` role) is checked, not built: it has no output, and an empty module per grammar
    // file under host/ would be 344 files nothing imports (compile/mill-check.ts)
    if (roleOf(file) === 'mill') {
      continue
    }

    // a look stylesheet emits CSS, not TypeScript: write it to a sibling `.css` under host/
    const isCss = typeof result.css === 'string'
    const outPath = path.join(
      root,
      'host',
      path
        .relative(root, file)
        .replace(/\.tree$/, isCss ? '.css' : '.ts'),
    )

    const content = isCss ? result.css! : result.typescript

    // only write when the output actually changed (content-addressed): an unchanged artifact is left untouched
    let existing: string | undefined

    try {
      existing = readFileSync(outPath, 'utf8')
    } catch {
      existing = undefined
    }

    if (existing !== content) {
      mkdirSync(path.dirname(outPath), { recursive: true })
      writeFileSync(outPath, content)
      written++
    }

    // and its style tables, light and dark, for a host with no CSS engine (native-dom-0008, 0048)
    const tables: [string, string | undefined][] = isCss
      ? [['.style', result.style], ['.dark.style', result.styleDark]]
      : []

    for (const [extension, table] of tables) {
      if (table === undefined) {
        continue
      }

      const stylePath = outPath.replace(/\.css$/, extension)
      let held: string | undefined

      try {
        held = readFileSync(stylePath, 'utf8')
      } catch {
        held = undefined
      }

      if (held !== table) {
        writeFileSync(stylePath, table)
        written++
      }
    }
  }

  // an app's shadows of face's platform implementations take exactly face's contract, or the build fails: a shadow
  // that drops or renames a prop would compile, and the author's `bind` would mean something else on one platform
  // (native-dom-0025). Face's own are held by test/compile/face-contract.ts.
  for (const finding of appShadowFindings(root, resolve)) {
    failed++
    const fault = `${path.relative(root, finding.file)}: shadows face's ${finding.component} on ${finding.rung} and ${finding.problem}`
    errors.push(fault)
    faults.push(fault)
  }

  return {
    compiled,
    written,
    failed,
    errors,
    warnings,
    problems,
    faults,
    open: [...open].sort(),
    obligations,
  }
}

// the contract findings for a project's own `code/component/native/` against face's generics, none for face itself
function appShadowFindings(root: string, resolve: Resolver): ContractFinding[] {
  const own = path.join(root, FACE_NATIVE_PATH)
  const manifest = path.join(root, 'deck.tree')

  if (!existsSync(own) || (existsSync(manifest) && manifestNameOf(manifest) === '@term/face')) {
    return []
  }

  // face's generics, found the way an import finds them
  const generic = resolve('@term/face/code/component/switch', path.join(root, 'deck.tree'))

  if (!generic) {
    return []
  }

  return contractFindings(path.join(path.dirname(generic.file), 'native'), own)
}

// stable, flat artifact name per source module under host/.unit/: its deck's name and its path inside the deck
// (`_term_base_code_text`), the same from every project. A unit's emitted imports name the modules it loads by this,
// and a unit is shared by every project on the machine (the `unit` cache kind), so the name cannot depend on which
// project built it: it was the path relative to the project root, and the standard library's units one project built
// imported `./.._base_code_string` into a project whose own copy was `./.._term_deck_term_deck_base_code_string`. A
// file in no deck keeps the path relative to the root
export function unitSlug(root: string, file: string, deckOf: DeckOf = projectDeckOf()): string {
  const deck = deckOf(file)
  const named = deck ? `${deck.name}/${path.relative(deck.root, file)}` : path.relative(root, file)

  return named.replace(/\.tree$/, '').replace(/[^A-Za-z0-9._-]/g, '_')
}

// THE ENTRY SHIM: the classic host/<path>.ts artifact exports what the merged build's artifact exported, every public
// task, constant and type of the entry's closure (`exports`), each from the module that defines it, so a TypeScript
// importer keeps its import path and its names. Only the entry's own module was re-exported at first, and zone's test
// helper read `tonePack`, a standard library task, off `seal/base` and got undefined
export function entryShim(
  root: string,
  file: string,
  exports: { name: string; exported: string; file: string; type: boolean }[],
  slug: (file: string) => string,
): string {
  const outPath = path.join(root, 'host', path.relative(root, file).replace(/\.tree$/, '.ts'))

  const unitOf = (module: string): string => {
    const relative = path
      .relative(path.dirname(outPath), path.join(root, 'host', '.unit', slug(module)))
      .split(path.sep)
      .join('/')

    // `./` or `../` makes it a relative import. A shim at the root of host/ reaches `.unit/x`, which begins with a
    // dot and is a PACKAGE name all the same, so a bundler left it external and node failed to find it
    return relative.startsWith('./') || relative.startsWith('../') ? relative : `./${relative}`
  }

  const values = new Map<string, string[]>()
  const types = new Map<string, string[]>()

  for (const one of exports) {
    const spell = one.type ? toPascal : toCamel
    const local = spell(one.name)
    const remote = spell(one.exported)
    const into = one.type ? types : values

    into.set(one.file, [...(into.get(one.file) ?? []), remote === local ? local : `${remote} as ${local}`])
  }

  const lines = [
    ...[...values].map(([module, names]) => `export { ${names.join(', ')} } from '${unitOf(module)}'`),
    ...[...types].map(([module, names]) => `export type { ${names.join(', ')} } from '${unitOf(module)}'`),
  ]

  return `${lines.join('\n')}\n`
}

// a file that is not a program, and so is compiled whole rather than cut into units: a mill definition, a data file,
// a look stylesheet
export function isWholeFile(file: string, text: string, role: string | null | undefined): boolean {
  return role === 'mill' || role === 'host' || (!role && isDataFile({ file, text })) || isLookStylesheet({ file, text })
}

// Separate compilation for the whole project (`term make --separate`): every module of every entry's closure is
// checked once against its dependencies' INTERFACES and emitted once into host/.unit/<slug>.ts (imports are
// sibling-relative, so one artifact serves every importer), with each entry keeping a re-export shim at its classic
// host/<path>.ts location. Units are cached by content + dependency interface hashes, so a body-only edit in a
// shared module rebuilds one unit and replays the rest: cross-boundary early cutoff, live on the batch path.
// See note/term/incremental-compilation.md ("What is live vs pending") and code/compile/separate.ts.
export function compileProjectSeparate(
  root: string,
  cache: CompileCache = projectCache(root),
  platform = 'node',
  // what one build learns and the next may keep: an answer per unit, a walk per module, an answer per load. A batch
  // build makes its own; a watch keeps one across rebuilds (`watchProject`), so an edit re-walks only the module it
  // changed and asks the filesystem nothing it asked before, until a file appears or disappears
  session: BuildSession = buildSession(root),
  // each entry's answer, built already by a parallel pass over the units (build-separate-parallel.ts)
  precomputed?: Map<string, SeparateResult>,
  // why each unit built was built (`term make --explain`, `explainStore`)
  explain?: UnitExplain,
): {
  compiled: number
  written: number
  failed: number
  errors: string[]
  warnings: string[]
  problems: BuildProblem[]
  faults: string[]
  open: string[]
  obligations: Owed
  built: number
  reused: number
  // each built program entry's closure key, which the roll is cached by (call/code/roll.ts `projectRoll`)
  closures: Map<string, string>
} {
  const files = findTreeFiles(root, [], platform)
  const { resolve, parsed, units, walked } = session
  // the entries this build must build again: those whose closure holds a file that moved since the session's last
  // build (compile/reach.tree). The rest replay what they built to then. Every entry builds when the session cannot
  // say what moved
  const moved = session.turn(files)
  const stale =
    moved === undefined ? undefined : new Set(staleEntries(new Map([...walked].map(([file, one]) => [file, one.edges])), files, moved))
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  const leanOf = projectLeanOf(root)
  const problems: BuildProblem[] = []
  const faults: string[] = []
  const warnings: string[] = []
  const open = new Set<string>()
  const obligations: Owed = { total: 0, proven: 0 }

  const slug = (file: string): string => unitSlug(root, file, deckOf)

  let compiled = 0
  let written = 0
  let failed = 0
  let built = 0
  let reused = 0

  const errors: string[] = []
  // each built program entry's closure key, which the roll is cached by (`projectRoll`)
  const closures = new Map<string, string>()

  // Artifacts are written AS THEY ARE PRODUCED, and this remembers only which paths have been written.
  //
  // It used to be a `Map<path, content>` drained after the loop, which held every emitted file's TEXT until the whole
  // project had compiled: O(files) in emitted bytes, tens of kilobytes each. The map was there to dedupe, because a
  // shared module's `.unit` artifact is produced by every entry that imports it. A Set of PATHS dedupes exactly as
  // well at about a hundred bytes an entry, and the write itself is already content-addressed, so nothing changes
  // except how much is resident. See test/compile/build-memory.ts for the shape this protects.
  const written_paths = new Set<string>()

  // content-addressed: an unchanged artifact is left untouched, so a rebuild touches only what differs
  const writeArtifact = (outPath: string, content: string): void => {
    if (written_paths.has(outPath)) {
      return
    }

    written_paths.add(outPath)

    let existing: string | undefined

    try {
      existing = readFileSync(outPath, 'utf8')
    } catch {
      existing = undefined
    }

    if (existing !== content) {
      mkdirSync(path.dirname(outPath), { recursive: true })
      writeFileSync(outPath, content)
      written++
    }
  }

  for (const file of files) {
    const replay = stale?.has(file) === false ? session.entries.get(file) : undefined

    if (replay) {
      compiled++
      reused += replay.units
      closures.set(file, replay.closureKey)
      problems.push(...replay.problems)
      warnings.push(...replay.problems.map(problem => renderDiagnostic(problem.diagnostic, problem.text)))
      replay.open.forEach(claim => open.add(claim))
      addOwed(obligations, replay.obligations)
      continue
    }

    session.entries.delete(file)

    // a file of `test` blocks, or a feed grammar, is built as compileProject builds it (`buildable`)
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit) {
      failed++

      for (const fault of unit.faults) {
        errors.push(`${path.relative(root, file)}: ${fault}`)
        faults.push(`${path.relative(root, file)}: ${fault}`)
      }

      continue
    }

    const { text, generated: grammar } = unit
    const framed = (diagnostic: Diagnostic): BuildProblem =>
      diagnostic.file !== file ? { diagnostic, text: undefined } : unit.place(diagnostic)

    // a file that is not a program has no module graph to split: a look stylesheet (CSS), a data file (a JSON
    // module) and a mill definition (checked, never built). Each goes through compile() exactly as the merged build
    // sends it, and is written where the merged build writes it
    const role = roleOf(file)

    if (isWholeFile(file, text, role)) {
      const one = compile({ file, text }, { resolve, cache, parsed, walked, deckOf, roleOf, leanOf })

      if (!one.ok) {
        failed++

        for (const problem of one.diagnostics.map(framed)) {
          errors.push(renderDiagnostic(problem.diagnostic, problem.text))
          problems.push(problem)
        }

        continue
      }

      compiled++

      if (role === 'mill') {
        continue
      }

      const isCss = typeof one.css === 'string'
      const outPath = path.join(root, 'host', path.relative(root, file).replace(/\.tree$/, isCss ? '.css' : '.ts'))

      writeArtifact(outPath, isCss ? one.css! : one.typescript)

      // and its style tables, light and dark, for a host with no CSS engine (native-dom-0008, 0048)
      for (const [extension, table] of [['.style', one.style], ['.dark.style', one.styleDark]] as const) {
        if (isCss && table !== undefined) {
          writeArtifact(outPath.replace(/\.css$/, extension), table)
        }
      }

      continue
    }

    // a parallel pass may have built it already (build-separate-parallel.ts), with these same options in a worker
    const result = precomputed?.get(file) ?? compileSeparate(
      { file, text },
      // roleOf comes along: a unit compiled separately has to be asked the same question about its role as one
      // compiled through the merged path, or the two disagree about whether a `hook` is a command or a route
      {
        resolve,
        cache,
        modules: f => `./${slug(f)}`,
        roleOf,
        leanOf,
        deckOf,
        parsed,
        units,
        walked,
        explain,
      },
    )

    if (!result.ok) {
      failed++

      for (const problem of result.diagnostics.map(framed)) {
        errors.push(renderDiagnostic(problem.diagnostic, problem.text))
        problems.push(problem)
      }

      continue
    }

    compiled++
    built += result.built.length
    reused += result.reused.length

    // only this file's warnings, as compileProject reports them: a grammar's own compile is of the reader generated
    // from it, whose unused captures are about code nobody wrote
    const own: BuildProblem[] = []

    for (const warning of result.warnings) {
      if (warning.file === file && !(grammar && warning.name === 'unused-binding')) {
        const problem = framed(warning)
        warnings.push(renderDiagnostic(problem.diagnostic, problem.text))
        problems.push(problem)
        own.push(problem)
      }
    }

    for (const claim of result.openClaims ?? []) {
      open.add(claim)
    }

    addOwed(obligations, result.obligations)

    session.entries.set(file, {
      problems: own,
      open: result.openClaims ?? [],
      obligations: result.obligations,
      units: result.built.length + result.reused.length,
      closureKey: result.closureKey,
    })
    closures.set(file, result.closureKey)

    for (const [mfile, emit] of result.modules) {
      writeArtifact(
        path.join(root, 'host', '.unit', `${slug(mfile)}.ts`),
        emit.code,
      )
    }

    // the entry shim, written by the worker that built the entry when a parallel pass did (`shim`)
    writeArtifact(
      path.join(root, 'host', path.relative(root, file).replace(/\.tree$/, '.ts')),
      'shim' in result && typeof result.shim === 'string' ? result.shim : entryShim(root, file, result.exports, slug),
    )
  }

  // an app's shadows of face's platform implementations take exactly face's contract, as compileProject holds them
  for (const finding of appShadowFindings(root, resolve)) {
    failed++
    const fault = `${path.relative(root, finding.file)}: shadows face's ${finding.component} on ${finding.rung} and ${finding.problem}`
    errors.push(fault)
    faults.push(fault)
  }

  session.close()

  return {
    compiled,
    written,
    failed,
    errors,
    warnings,
    problems,
    faults,
    open: [...open].sort(),
    obligations,
    built,
    reused,
    closures,
  }
}

// watch the project's .tree files and recompile incrementally on change (a shared cache reuses unchanged modules).
// Debounced so a burst of saves triggers one rebuild. Runs until the process is killed.
export function watchProject(root: string, merged = false): void {
  const cache = projectCache(root)
  // the build graph of every rebuild, kept for the life of the watch: an edit rebuilds the entries it reaches, re-walks
  // the modules it changed, and misses the units whose text or imported surfaces it changed. Everything else is
  // answered from memory (`BuildSession`)
  const session = buildSession(root)

  openRun({ verb: 'make', root, facts: ['watching', ...(merged ? ['merged'] : [])] })
  stopOnInterrupt()

  // one `build` item per build, its problems before it, the file that changed as its subject. The run never closes
  // until ctrl-c: it is a stream (section 11)
  const build = (changed: string): void => {
    const started = Date.now()
    const result = merged ? compileProject(root, cache) : compileProjectSeparate(root, cache, 'node', session)
    reportProblems(result.problems, root, result.faults)
    report({
      glyph: result.failed > 0 ? 'failed' : 'done',
      verb: 'build',
      subject: changed,
      duration: Date.now() - started,
      counts: [count(result.compiled, 'files', 'file', result.compiled + result.failed), count(result.written, 'written')],
    })
  }

  build('typescript')
  watchTreeFiles(root, name => build(name))
}

// a watch ends on ctrl-c, with its closing item and exit 130 (section 18)
function stopOnInterrupt(): void {
  process.once('SIGINT', () => {
    process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true }))
  })
}

// watch every `.tree` file under `root` (recursively) and invoke `onChange` debounced on each edit, so a burst of saves
// triggers one rebuild. While an async `onChange` is in flight a further change is coalesced into the next run (no
// overlapping builds). `ignore` names path segments to skip (generated / dependency dirs); defaults to the make output
// `host/`. Returns a stop handle. Runs until stopped or the process is killed.
export function watchTreeFiles(
  root: string,
  onChange: (name: string) => void | Promise<void>,
  ignore: string[] = ['host/'],
): { close: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let running = false
  let pending = false

  const fire = async (name: string): Promise<void> => {
    if (running) {
      pending = true
      return
    }

    running = true

    try {
      await onChange(name)
    } finally {
      running = false

      if (pending) {
        pending = false
        void fire(name)
      }
    }
  }

  const watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
    const name = typeof filename === 'string' ? filename : ''

    if (!name.endsWith('.tree') || ignore.some(dir => name.includes(dir))) {
      return
    }

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(() => void fire(name), 30)
  })

  return { close: () => watcher.close() }
}

// watch and re-run the project's own build script (`pnpm run make`) on each change. Used when the project defines a
// custom build, so the watcher respects it rather than the built-in .tree -> host compile.
function watchScript(root: string): void {
  openRun({ verb: 'make', root, facts: ['package.json make', 'watching'] })
  stopOnInterrupt()

  const run = async (changed: string): Promise<void> => {
    const started = Date.now()
    const done = await runCaptured({ cmd: 'pnpm', args: ['run', 'make'], cwd: root, raw: outputOptions().raw })
    report({
      glyph: done.code === 0 ? 'done' : 'failed',
      verb: 'run',
      subject: changed,
      duration: Date.now() - started,
      exit: done.code,
      facts: ['pnpm run make'],
      quote: done.code === 0 && !outputOptions().verbose ? [] : done.lines,
    })
  }

  void run('pnpm run make')
  watchTreeFiles(root, name => run(name))
}

export async function callMake(input: {
  root: string
  ride?: boolean
  // the whole-program build instead of separate compilation, which is the default since 2026-10-05 (compileProjectSeparate).
  // Separate checks each module once per run against its imports' stubs and caches it by its own text and theirs, so
  // an edit rebuilds the edited module and what reads it. It agreed with this build on every file of every package
  // before the switch (`pnpm term:separate-diff`, test/compile/separate.ts)
  merged?: boolean
  // say why each unit that was built was built (step 6 of note/term/plan/incremental-best-in-class.md). The build runs
  // on one thread, since the reasons are found where each unit is built
  explain?: boolean
  // compile the .tree files even when package.json carries a `make` script.
  //
  // A package.json `make` script normally REPLACES the .tree build entirely, which is right when the script IS the
  // build, and a blind spot when the package has both: @term/base's script builds its 62 TypeScript runtime shims
  // while 825 .tree files sat uncompiled by anything, and nothing said so. This flag asks for the .tree half, and
  // task/term/build-all.ts uses it so no package can hide behind a script again.
  trees?: boolean
}): Promise<void> {
  try {
    const pkgJsonPath = path.join(input.root, 'package.json')

    let hasMakeScript = false

    try {
      const fs = await import('fs/promises')
      const pkgText = await fs.readFile(pkgJsonPath, 'utf-8')
      const pkg = JSON.parse(pkgText)
      hasMakeScript = Boolean(pkg.scripts?.make)
    } catch {
      // no package.json
    }

    if (hasMakeScript && !input.trees) {
      if (input.ride) {
        // watch mode with a custom build: re-run the project's `make` script on every change
        watchScript(input.root) // runs until interrupted
      } else {
        // the package's own build: its output quoted under the `run` item, in full when it failed or under
        // --verbose, the last 20 lines of it otherwise kept out of the way
        openRun({ verb: 'make', root: input.root, facts: ['package.json make'] })
        const started = Date.now()
        const run = await runCaptured({ cmd: 'pnpm', args: ['run', 'make'], cwd: input.root, raw: outputOptions().raw })
        report({
          glyph: run.code === 0 ? 'done' : 'failed',
          verb: 'run',
          subject: 'pnpm run make',
          duration: Date.now() - started,
          exit: run.code,
          quote: run.code === 0 && !outputOptions().verbose ? [] : run.lines,
        })
        closeRun({ verdict: run.code === 0 ? 'Built by its package script' : 'Its package script failed' })
      }

      return
    }

    if (input.ride) {
      watchProject(input.root, input.merged) // runs until interrupted

      return
    }

    // big projects fan out across worker threads (each runs the full compile(), sharing the on-disk cache); small
    // ones build sequentially since the worker bundle + spawn overhead would outweigh it. The parallel path is loaded
    // dynamically so make.ts's static graph (which the build worker itself bundles) never pulls esbuild. Any failure
    // setting up the pool falls back to the sequential build, so a worker problem never breaks `term make`.
    const fileCount = findTreeFiles(input.root).length
    // `--trees` beside a package script is a choice worth saying: the script did not run
    openRun({ verb: 'make', root: input.root, counts: [count(fileCount, 'files', 'file')], facts: hasMakeScript ? ['--trees'] : [] })

    {
      const separate = !input.merged
      const parallel =
        !separate && fileCount >= 16 && cpus().length > 2

      let result: {
        compiled: number
        failed: number
        errors: string[]
        problems: BuildProblem[]
        faults: string[]
        warnings?: string[]
        written?: number
        open?: string[]
        obligations?: { total: number; proven: number }
      }

      const started = Date.now()
      // the separate path's own counts, units built against units replayed from the cache
      let units: { built: number; reused: number } | undefined
      // and each entry's closure key, which the roll below is cached by
      let closures: Map<string, string> | undefined

      if (separate) {
        const session = buildSession(input.root)
        let precomputed: Map<string, SeparateResult> | undefined
        let pooled = 0
        const explain = input.explain ? explainStore(input.root) : undefined

        // a big project's units are built across worker threads first, in dependency order, and the build below then
        // writes what they answered (build-separate-parallel.ts). A pool that cannot start leaves it to the build
        if (!explain && fileCount >= 16 && cpus().length > 2) {
          try {
            const { compileUnitsParallel } = await import('@term/call/code/build-separate-parallel')
            const pooledAt = Date.now()
            const pool = await compileUnitsParallel(input.root, findTreeFiles(input.root, [], 'node'), session)
            precomputed = pool.results
            pooled = pool.built

            // the pool's part of the build, apart: its units, its workers, its time, and what it could not answer
            report({
              glyph: pool.failures.length > 0 ? 'warning' : 'done',
              verb: 'build',
              subject: 'units in parallel',
              duration: Date.now() - pooledAt,
              counts: [count(pool.jobs, 'units', 'unit'), count(pool.workers, 'workers', 'worker')],
              // where the time went: the walk before the pool, and the workers' building and rolling, summed
              facts: [
                `walk ${Math.round(pool.spent.walking / 1000)} s`,
                `build ${Math.round(pool.spent.building / 1000)} s of workers`,
                `roll ${Math.round(pool.spent.rolling / 1000)} s of workers`,
              ],
              ...(pool.failures.length > 0 ? { message: pool.failures.slice(0, 5) } : {}),
            })
          } catch {
            precomputed = undefined
          }
        }

        const built = compileProjectSeparate(input.root, undefined, 'node', session, precomputed, explain)
        result = built
        units = { built: built.built + pooled, reused: built.reused }
        closures = built.closures

        // one item per unit built, its reasons under it
        for (const [label, reasons] of explain?.reasons ?? []) {
          const subject = label
            .split('+')
            .map(file => (isWithin(file, input.root) ? path.relative(input.root, file) : file))
            .join(' + ')

          report({ glyph: 'info', verb: 'built', subject, message: reasons })
        }
      } else if (parallel) {
        try {
          const { compileProjectParallel } = await import(
            '@term/call/code/build-parallel'
          )
          result = await compileProjectParallel(input.root)
        } catch {
          result = compileProject(input.root)
        }
      } else {
        result = compileProject(input.root)
      }

      const { compiled, failed } = result
      // each entry's own open claims, which both paths report: the separate path carries the entry unit's
      const openClaims =
        'open' in result && Array.isArray(result.open)
          ? (result.open as string[])
          : undefined

      // every error and the project's own warnings, as Problem items with their code frames (section 12)
      reportProblems(result.problems, input.root, result.faults)
      const warnings = result.problems.filter(one => one.diagnostic.severity === 'warning').length
      const errorCount = result.problems.length - warnings + result.faults.length

      const facts: string[] = []

      // the default says nothing; the whole-program build says which it was
      if (!units) {
        facts.push('merged')
      }

      report({
        glyph: failed > 0 ? 'failed' : 'done',
        verb: 'build',
        subject: 'typescript',
        duration: Date.now() - started,
        counts: [
          count(compiled, 'files', 'file', fileCount),
          ...(result.written !== undefined ? [count(result.written, 'written')] : []),
          ...(units ? [count(units.built, 'units built', 'unit built'), count(units.reused, 'reused')] : []),
        ],
        facts,
      })

      if (failed > 0) {
        closeRun({
          verdict: 'Build failed',
          counts: [count(errorCount, 'errors', 'error'), ...(warnings ? [count(warnings, 'warnings', 'warning')] : [])],
        })

        return
      }

      if (compiled === 0) {
        closeRun({ verdict: 'Nothing to build', message: ['There is no .tree file here.'] })

        return
      }

      // AN OPEN CLAIM IS NOT A PROVEN ONE. A `rule` carrying `mark open` compiles, because a book under
      // construction has to, but the count says so on every build rather than letting it pass in silence.
      // `term hold` is the gate that refuses while this is non-zero. note/term/project/law-proof-gate.md.
      if (openClaims && openClaims.length > 0) {
        report({
          glyph: 'warning',
          verb: 'prove',
          subject: `${openClaims.length} claim${openClaims.length === 1 ? ' is' : 's are'} left open`,
          message: [openClaims.join(', ')],
          fields: [field('next', 'term hold')],
        })
      }

      // TIER 0, counted on every build: what the project's tasks are proven free of with nothing written. The
      // build never fails on it; `term hold` is the gate, against hold.json. note/term/proof-by-default/.
      const obligations =
        'obligations' in result &&
        result.obligations &&
        typeof result.obligations === 'object'
          ? (result.obligations as Owed)
          : undefined

      if (obligations && obligations.total > 0) {
        report({
          glyph: 'info',
          verb: 'prove',
          // each kind named with its own count: a walk's termination was counted under the first two
          subject: `tier 0: ${describeOwed(obligations)}`,
          counts: [count(obligations.proven, 'proven', '', obligations.total)],
          facts: ['term hold gates the rest'],
        })
      }

      // the roll of the project's own entries, beside the output, for tools that are not Term. Every compile
      // above is cached, so this costs the roll pass and nothing else. See code/compile/roll.ts.
      try {
        const { projectRoll } = await import('@term/call/code/roll')
        const rolledAt = Date.now()
        const { roll } = projectRoll(input.root, closures)
        const fs = await import('fs')
        const rollPath = path.join(input.root, 'host', 'roll.json')
        const text = JSON.stringify(roll, null, 2) + '\n'

        let existing: string | undefined

        try {
          existing = fs.readFileSync(rollPath, 'utf8')
        } catch {
          existing = undefined
        }

        if (existing !== text) {
          fs.mkdirSync(path.dirname(rollPath), { recursive: true })
          fs.writeFileSync(rollPath, text)
        }

        report({
          glyph: 'info',
          verb: 'write',
          subject: 'host/roll.json',
          duration: Date.now() - rolledAt,
          counts: [
            count(roll.exception.length, 'exceptions', 'exception'),
            count(roll.task.length, 'tasks', 'task'),
            count(roll.dock.length, 'routes', 'route'),
            count(roll.tell.length, 'tells', 'tell'),
          ],
        })
      } catch (error) {
        report({ glyph: 'warning', verb: 'write', subject: 'host/roll.json was not written', message: [error instanceof Error ? error.message : String(error)] })
      }

      closeRun({
        verdict: `${compiled} file${compiled === 1 ? '' : 's'} built`,
        counts: warnings ? [count(warnings, 'warnings', 'warning')] : [],
      })
    }
  } catch (err) {
    failRun(err, input.root)
  }
}

function runCommand(input: {
  cmd: string
  args: string[]
  cwd: string
  // run through a shell (PATH lookup of script shims like `pnpm`). A long-running server (`term boot`) sets this false
  // so ctrl-c reaches the process directly and no shell sits in between.
  shell?: boolean
}): Promise<void> {
  return new Promise((resolve, reject) => {
    // `detached` puts the child in its OWN process group, so an interrupt can be delivered to the WHOLE group (the child
    // plus anything it spawned) with `process.kill(-pid)`. The terminal's ctrl-c (which targets the foreground group)
    // no longer reaches the child directly, so the parent owns the single, deterministic teardown path below.
    const child = spawn(input.cmd, input.args, {
      cwd: input.cwd,
      stdio: 'inherit',
      shell: input.shell ?? true,
      detached: true,
    })

    let killTimer: ReturnType<typeof setTimeout> | undefined

    // take down the child's entire process group; fall back to killing the lone child if the group send fails (e.g. it
    // already exited). Group-kill guarantees no orphaned grandchildren are left holding the port.
    const killGroup = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) {
        return
      }

      try {
        process.kill(-child.pid, signal)
      } catch {
        try {
          child.kill(signal)
        } catch {
          // already gone
        }
      }
    }

    // on ctrl-c / SIGTERM: signal the group, then SIGKILL the group if it does not exit within a short grace window, so
    // a child ignoring the signal cannot hang the terminal. The parent waits for `close` before resolving.
    const forward = (signal: NodeJS.Signals) => {
      killGroup(signal)

      if (!killTimer) {
        killTimer = setTimeout(() => killGroup('SIGKILL'), 4000)
      }
    }

    // never leave an orphan: if the parent process exits for ANY reason, force the group down synchronously
    const onParentExit = () => killGroup('SIGKILL')

    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)
    process.on('exit', onParentExit)

    child.on('close', (code, signal) => {
      if (killTimer) {
        clearTimeout(killTimer)
      }

      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      process.off('exit', onParentExit)

      // a clean exit, or termination by a signal (ctrl-c), is not an error
      if (code === 0 || code === null || signal) {
        resolve()
      } else {
        reject(new Error(`Process exited with code ${code}`))
      }
    })

    child.on('error', err => {
      if (killTimer) {
        clearTimeout(killTimer)
      }

      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      process.off('exit', onParentExit)
      reject(err)
    })
  })
}

// a child run for its output: every line it writes, both streams in the order they arrive, and its exit code. Never
// rejects. The output is QUOTED under the item that ran it (section 15), so nothing it prints mixes into the tool's
// own lines; `--raw` (`raw`) passes it through untouched instead, and then `lines` is empty
function runCaptured(input: { cmd: string; args: string[]; cwd: string; raw: boolean }): Promise<{ code: number; lines: string[] }> {
  return new Promise(resolve => {
    const child = spawn(input.cmd, input.args, { cwd: input.cwd, stdio: input.raw ? 'inherit' : 'pipe', shell: true })
    const lines: string[] = []
    let partial = ''

    const take = (chunk: Buffer): void => {
      const text = partial + chunk.toString('utf8')
      const parts = text.split('\n')
      partial = parts.pop() ?? ''
      lines.push(...parts)
    }

    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('close', (code, signal) => {
      if (partial !== '') {
        lines.push(partial)
      }

      resolve({ code: code ?? (signal ? 130 : 1), lines })
    })
    child.on('error', error => resolve({ code: 127, lines: [...lines, String(error)] }))
  })
}

export { runCommand }
