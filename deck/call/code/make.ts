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
import { CompileCache } from '@term/make/code/compile/cache'
import { makeParseMemo } from '@term/make/code/compile/load'
import { projectCache } from '@term/call/code/cache-store'
import { preprocessTests } from '@term/call/code/test-preprocess'
import { isLockfileAt, isRoleFileAt, manifestNameOf } from '@term/call/code/manifest-name'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf } from '@term/call/code/role-of'
import { parse } from '@term/make/code/parser/tree'
import {
  compileFeedMine,
  feedMineLoads,
  feedMineSubstrate,
  readFeedMineGrammar,
} from '@term/make/code/compile/feed-mill'
import { withNativeEnv } from '@term/make/code/compile/native'
import type { NativeEnv } from '@term/make/code/compile/native'
import type { Resolver, Source } from '@term/make/code/compile/load'
import { stdlibResolver, linkResolver, siblingResolver } from '@term/call/code/walk'
import { renderDiagnostic } from '@term/call/code/report'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@term/make/code/tint'

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

// does this file declare itself unfinished? `note draft` on its own line, anywhere in the leading block before the
// first definition. Read cheaply: only the head of the file is inspected.
function isDraftTree(file: string): boolean {
  try {
    return /^note draft\s*$/m.test(readFileSync(file, 'utf8').slice(0, 2000))
  } catch {
    return false
  }
}

// is this file a package MANIFEST (a `deck @scope/name` statement), as opposed to a code module that merely shares
// the name? Parsed, never matched: deck/seed/code/deck.tree is a module, and telling them apart by filename skipped
// the entire stdlib.
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
function feedGrammarOf(
  file: string,
  text: string,
): ReturnType<typeof readFeedMineGrammar> | undefined {
  if (path.basename(file) !== 'mine.tree') {
    return undefined
  }

  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const grammar = readFeedMineGrammar(parsed.tree)

  return grammar.size > 0 ? grammar : undefined
}

export function findTreeFiles(
  dir: string,
  out: string[] = [],
  // the platform being built for; when given, other platforms' native trees are skipped. `shared` is always kept,
  // since it belongs to every target.
  platform?: string,
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

    if (statSync(full).isDirectory()) {
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
      // deck/seed/code/deck.tree (`load ./text ...`, the manifest's own shape as Term), so a filename test skipped
      // the whole of deck/seed/code — 803 files, the entire stdlib — and the build cheerfully reported success on
      // the 20 that were left. manifestNameOf parses it and answers only for a real `deck @scope/name`.
      if (isPackageManifest(path.join(full, 'deck.tree'))) {
        continue
      }

      findTreeFiles(full, out, platform)
    } else if (entry.endsWith('.tree')) {
      // a package MANIFEST is read by the package manager and is not Term code. Compiling one emitted an empty
      // module that nothing imports, and only ever produced misleading errors: a manifest head the code mill does not
      // know (`boot`, `back`, `hook`, `face`, `book` in test/site/deck.tree) was reported as an undefined NAME. A
      // root manifest happened to compile clean because its heads (`deck`, `load`, `bear`) are also code heads, so
      // the rule looked like it worked. The manifest grammar is checked where it is read, not here.
      //
      // Again: MANIFEST, not filename. deck/seed/code/deck.tree is an ordinary stdlib module.
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
      // Content, not filename: deck/seed/code/task/lock.tree is an ordinary module.
      if (entry === 'lock.tree' && isLockfileAt(full)) {
        continue
      }

      // a file that declares `note draft` is unfinished and is not built. This keeps a half-written module in the
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

    if (!candidate) {
      return undefined
    }

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

  const packageRootOf = (file: string): string => {
    let dir = path.dirname(file)

    for (;;) {
      if (existsSync(path.join(dir, 'deck.tree'))) {return safeReal(dir)}

      const up = path.dirname(dir)

      if (up === dir) {return rootReal}

      dir = up
    }
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

  const base: Resolver = (rawImportPath, fromFile) => {
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

    const memoKey = relative
      ? `${path.dirname(fromFile)}\0${importPath}`
      : importPath

    const memoHit = resolveMemo.get(memoKey)

    if (memoHit !== undefined || resolveMemo.has(memoKey)) {
      return memoHit
    }

    const result = resolveUncached(importPath, fromFile, relative)
    resolveMemo.set(memoKey, result)

    return result
  }

  const resolveUncached = (
    importPath: string,
    fromFile: string,
    relative: boolean,
  ): Source | undefined => {
    // a relative import resolves against the importing file (the framework's modules import each other this way)
    if (relative) {
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
      linked(importPath, fromFile) ??
      fallbackLinked?.(importPath, fromFile)

    if (fromLink) {
      return fromLink
    }

    const fromStdlib = stdlib?.(importPath, fromFile)

    if (fromStdlib) {
      return fromStdlib
    }

    // any other package in the same tree as the stdlib, by name and without a `link/` entry. After the link dir, so
    // a project that genuinely links its own copy of a package still wins. See siblingResolver.
    const fromSibling = sibling?.(importPath, fromFile)

    if (fromSibling) {
      return fromSibling
    }

    // `@scope/pkg/code/sub` -> `<that package's root>/code/sub.tree` when it names the importer's OWN package.
    // A package that imports itself by its declared name has no `link/` entry pointing at itself and should not
    // need one: @term/bind does this 11,503 times and @term/site 5, and every one of them silently resolved to
    // nothing, so the imported names existed but could not be used. The remainder of the path already begins
    // with `code/`, which is why it is joined to the package root directly — the fallback below joins it under
    // `<root>/code` and so builds `<root>/code/code/...`, a path that never exists.
    const ownPackage = packageNameOf(fromFile)

    if (ownPackage && importPath.startsWith(`${ownPackage}/`)) {
      const withinSelf = tryFile(
        path.join(packageRootOf(fromFile) ?? root, importPath.slice(ownPackage.length + 1)),
      )

      if (withinSelf) {
        return withinSelf
      }
    }

    // `@scope/pkg/sub/path` -> `<root>/code/sub/path.tree` when it refers to this project
    const segments = importPath
      .replace(/^@[^/]+\/[^/]+\//, '')
      .split('/')

    const candidate = path.join(
      root,
      'code',
      `${segments.join('/')}.tree`,
    )

    const cached = readCache.get(candidate)

    if (cached !== undefined || readCache.has(candidate)) {
      return cached
    }

    let result: Source | undefined

    try {
      result = {
        file: candidate,
        text: readFileSync(candidate, 'utf8'),
      }
    } catch {
      result = undefined
    }

    readCache.set(candidate, result)

    return result
  }

  return withNativeEnv(env, base)
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
): { compiled: number; written: number; failed: number; errors: string[] } {
  const files = findTreeFiles(root, [], platform)
  const resolve = projectResolver(root)
  const deckOf = projectDeckOf()
  const roleOf = projectRoleOf(root)
  // ONE PARSE MEMO FOR THE WHOLE PROJECT, not one per file. Every entry walks its import closure to work out its
  // cache key, and that walk runs before the cache can be asked, so a memo per entry re-parses the stdlib for every
  // file in the project. See makeParseMemo in compile/load.ts.
  const parsed = makeParseMemo()

  let compiled = 0
  let written = 0
  let failed = 0

  const errors: string[] = []

  for (const file of files) {
    // a file carrying `test <phrase>` blocks is not plain Term until the test preprocessor has rewritten them into
    // tasks. `term test` does that before compiling; a plain build has to as well, or every test file in the project
    // fails here on a construct the compiler is never meant to see.
    const source = readFileSync(file, 'utf8')

    // A `mine.tree` is a GRAMMAR, not Term code. The build generates the reader it describes and compiles THAT, so
    // a dialect is written once, as the grammar, instead of twice as a grammar and a hand-written reader that
    // drifts from it. Which is the whole point of feed-mill: the two cannot disagree if there is only one.
    //
    // The SUBSTRATE is inferred, never asked for. `byte`, `int` and `bytes` can only read a byte cursor and `char`,
    // `text`, `range` and `span` can only read a text one, and across @term/feed's readable grammars six are
    // byte-only, eight text-only, and none use both. A grammar with no leaf to infer from is REPORTED rather than
    // guessed at: guessing would emit a reader that compiles and reads the wrong cursor.
    const grammar = feedGrammarOf(file, source)
    let text = source

    if (grammar) {
      const substrate = feedMineSubstrate(grammar)

      if (!substrate) {
        failed++
        errors.push(
          `${path.relative(root, file)}: cannot tell whether this grammar reads bytes or text. ` +
            `Every rule in it is a combinator over rules with no body, so there is no leaf to infer from. ` +
            `Write one of its leaf rules, or shelve the grammar with \`note draft\` until it has one.`,
        )
        continue
      }

      // the grammar's own `load` blocks come through verbatim: a `mine value` may call a real helper, and where
      // that helper lives is a fact only the grammar knows
      text = compileFeedMine(
        grammar,
        substrate,
        FEED_CURSOR,
        feedMineLoads(file, source),
      )
    } else if (/^\s*test /m.test(source)) {
      // a file carrying `test <phrase>` blocks is not plain Term until the test preprocessor has rewritten them
      // into tasks. `term test` does that before compiling; a plain build has to as well, or every test file in
      // the project fails here on a construct the compiler is never meant to see.
      text = preprocessTests(source).text
    }

    const result = compile(
      { file, text },
      { resolve, cache, parsed, deckOf, roleOf },
    )

    if (!result.ok) {
      failed++

      // render each diagnostic as a rich, colored source frame (header + locator + caret), reusing the in-memory text
      // for diagnostics in this file and reading imported modules from disk.
      for (const diagnostic of result.diagnostics) {
        errors.push(
          renderDiagnostic(
            diagnostic,
            diagnostic.file === file ? text : undefined,
          ),
        )
      }

      continue
    }

    compiled++

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
  }

  return { compiled, written, failed, errors }
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
): {
  compiled: number
  written: number
  failed: number
  errors: string[]
  built: number
  reused: number
} {
  const files = findTreeFiles(root, [], 'node')
  const resolve = projectResolver(root)

  // stable, flat artifact name per source module. Project files key by their root-relative path; imported modules
  // living outside the root (stdlib / linked decks) key by their path with separators flattened.
  const slug = (file: string): string =>
    path
      .relative(root, file)
      .replace(/\.tree$/, '')
      .replace(/[^A-Za-z0-9._-]/g, '_')

  let compiled = 0
  let written = 0
  let failed = 0
  let built = 0
  let reused = 0

  const errors: string[] = []

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
    const text = readFileSync(file, 'utf8')

    // a look stylesheet has no module graph: route it through the merged path's CSS backend as before
    if (isLookStylesheet({ file, text })) {
      const sheet = compile({ file, text }, { resolve, cache })

      if (sheet.ok && typeof sheet.css === 'string') {
        compiled++
        writeArtifact(
          path.join(
            root,
            'host',
            path.relative(root, file).replace(/\.tree$/, '.css'),
          ),
          sheet.css,
        )
      }

      continue
    }

    const result = compileSeparate(
      { file, text },
      // roleOf comes along: a unit compiled separately has to be asked the same question about its role as one
      // compiled through the merged path, or the two disagree about whether a `hook` is a command or a route
      { resolve, cache, modules: f => `./${slug(f)}`, roleOf: projectRoleOf(root) },
    )

    if (!result.ok) {
      failed++

      for (const diagnostic of result.diagnostics) {
        errors.push(
          renderDiagnostic(
            diagnostic,
            diagnostic.file === file ? text : undefined,
          ),
        )
      }

      continue
    }

    compiled++
    built += result.built.length
    reused += result.reused.length

    for (const [mfile, emit] of result.modules) {
      writeArtifact(
        path.join(root, 'host', '.unit', `${slug(mfile)}.ts`),
        emit.code,
      )
    }

    // the entry shim: the classic host/<path>.ts artifact re-exports the entry's own module, so downstream
    // consumers keep their import paths
    const outPath = path.join(
      root,
      'host',
      path.relative(root, file).replace(/\.tree$/, '.ts'),
    )

    const toUnit = path
      .relative(
        path.dirname(outPath),
        path.join(root, 'host', '.unit', slug(file)),
      )
      .split(path.sep)
      .join('/')

    writeArtifact(
      outPath,
      `export * from '${toUnit.startsWith('.') ? toUnit : `./${toUnit}`}'\n`,
    )
  }

  return { compiled, written, failed, errors, built, reused }
}

// watch the project's .tree files and recompile incrementally on change (a shared cache reuses unchanged modules).
// Debounced so a burst of saves triggers one rebuild. Runs until the process is killed.
export function watchProject(root: string): void {
  const cache = projectCache(root)

  const build = (label: string): void => {
    const { compiled, written, failed, errors } = compileProject(root, cache)

    for (const error of errors) {
      console.error('\n' + error)
    }

    if (failed > 0) {
      logFail(`${label}: ${compiled} ok, ${failed} failed`)
    } else if (written === 0) {
      logGood(`${label}: up to date (${compiled} file${compiled === 1 ? '' : 's'})`)
    } else {
      logGood(
        `${label}: ${written} of ${compiled} file${
          compiled === 1 ? '' : 's'
        } changed -> host/`,
      )
    }
  }

  build('built')
  console.log(fade('  watching for changes... (ctrl-c to stop)'))

  watchTreeFiles(root, name => build(`rebuilt (${name})`))
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
  const run = async (label: string): Promise<void> => {
    logStep(label)

    try {
      await runCommand({ cmd: 'pnpm', args: ['run', 'make'], cwd: root })
      logGood(`${label}: done`)
    } catch (error) {
      logFail(formatError(error))
    }
  }

  void run('build')
  console.log(fade('  watching for changes... (ctrl-c to stop)'))

  watchTreeFiles(root, name => run(`rebuild (${name})`))
}

export async function callMake(input: {
  root: string
  ride?: boolean
  // separate compilation: per-module artifacts + cross-boundary early cutoff (opt-in while the differential
  // harness matures; see compileProjectSeparate)
  separate?: boolean
  // compile the .tree files even when package.json carries a `make` script.
  //
  // A package.json `make` script normally REPLACES the .tree build entirely, which is right when the script IS the
  // build, and a blind spot when the package has both: @term/seed's script builds its 62 TypeScript runtime shims
  // while 825 .tree files sat uncompiled by anything, and nothing said so. This flag asks for the .tree half, and
  // task/term/build-all.ts uses it so no package can hide behind a script again.
  trees?: boolean
}): Promise<void> {
  logStep(input.ride ? 'Watching and compiling...' : 'Compiling...')

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
        await runCommand({ cmd: 'pnpm', args: ['run', 'make'], cwd: input.root })
        logGood('Build complete')
      }
    } else if (input.ride) {
      console.log(
        fade(
          '  No build script found. Watching .tree files (incremental)...',
        ),
      )
      watchProject(input.root) // runs until interrupted
    } else {
      console.log(
        fade(
          hasMakeScript
            ? '  Compiling .tree files directly (--trees; its `make` script was not run)...'
            : '  No build script found. Compiling .tree files directly...',
        ),
      )

      // big projects fan out across worker threads (each runs the full compile(), sharing the on-disk cache); small
      // ones build sequentially since the worker bundle + spawn overhead would outweigh it. The parallel path is loaded
      // dynamically so make.ts's static graph (which the build worker itself bundles) never pulls esbuild. Any failure
      // setting up the pool falls back to the sequential build, so a worker problem never breaks `term make`.
      const fileCount = findTreeFiles(input.root).length
      const parallel =
        !input.separate && fileCount >= 16 && cpus().length > 2

      let result: {
        compiled: number
        failed: number
        errors: string[]
        written?: number
      }

      if (input.separate) {
        const separate = compileProjectSeparate(input.root)
        result = separate
        console.log(
          fade(
            `  separate: ${separate.built} unit${
              separate.built === 1 ? '' : 's'
            } built, ${separate.reused} reused`,
          ),
        )
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

      const { compiled, failed, errors } = result

      for (const error of errors) {
        console.error('\n' + error)
      }

      if (failed > 0) {
        logFail(
          `Compiled ${compiled} file${
            compiled === 1 ? '' : 's'
          }, ${failed} failed.`,
        )
        process.exit(1)
      }

      if (compiled === 0) {
        console.log(fade('  No .tree files found.'))
      } else {
        logGood(
          `Compiled ${compiled} file${
            compiled === 1 ? '' : 's'
          } to host/`,
        )

        // the roll of the project's own entries, beside the output, for tools that are not Term. Every compile
        // above is cached, so this costs the roll pass and nothing else. See code/compile/roll.ts.
        try {
          const { projectRoll } = await import('@term/call/code/roll')
          const { roll } = projectRoll(input.root)
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

          console.log(
            fade(
              `  roll: ${roll.exception.length} exception(s), ${roll.task.length} task(s), ${roll.dock.length} route(s), ${roll.tell.length} tell(s) in host/roll.json`,
            ),
          )
        } catch (error) {
          console.log(fade(`  roll not written: ${String(error)}`))
        }
      }
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
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

export { runCommand }
