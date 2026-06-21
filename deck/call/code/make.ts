import { spawn } from 'child_process'
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
import { compile } from '@cluesurf/make/code/compile/compile'
import { CompileCache } from '@cluesurf/make/code/compile/cache'
import { projectCache } from '@cluesurf/call/code/cache-store'
import { withNativeEnv } from '@cluesurf/make/code/compile/native'
import type { NativeEnv } from '@cluesurf/make/code/compile/native'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import { stdlibResolver, linkResolver } from '@cluesurf/call/code/walk'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  fade,
} from '@cluesurf/make/code/tint'

// every .tree file under a directory, skipping generated output and dependency / vcs folders
function findTreeFiles(
  dir: string,
  out: string[] = [],
): string[] {
  let entries: string[]

  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (
      entry === 'node_modules' ||
      entry === 'host' ||
      entry === '.git'
    )
      {continue}

    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) {findTreeFiles(full, out)}
    else if (entry.endsWith('.tree')) {out.push(full)}
  }

  return out
}

// the on-disk file a bare module path points at, applying Seed's candidate order (`foo.tree`, then `foo/base.tree`,
// then `foo/note.tree`). Returns the first that exists, else undefined. Shared by the build resolver and `seed boot`.
export function resolveTreeFile(base: string): string | undefined {
  for (const candidate of [
    `${base}.tree`,
    path.join(base, 'base.tree'),
    path.join(base, 'note.tree'),
  ]) {
    if (existsSync(candidate)) {return candidate}
  }

  return undefined
}

// the resolver a project build uses: the bundled stdlib (`@cluesurf/base/...`) plus the project's own `.tree` files,
// wrapped so abstract native imports resolve to the target platform's implementation (default node)
// realpath if it exists, else a normalized absolute path (so confinement
// checks work for not-yet-existing candidates too).
function safeReal(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

// is `child` inside `parent` (or equal to it)? compared on normalized paths.
function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

export function projectResolver(
  root: string,
  env: NativeEnv = 'node',
  // an optional second `link/` root tried after the project's own. The CLI passes its own install dir here, so an app
  // that has not run `seed link` itself still resolves `@cluesurf/*` through the seed install's stdlib links.
  fallbackLinkRoot?: string,
): Resolver {
  const stdlib = stdlibResolver()
  const linked = linkResolver(root)
  const fallbackLinked =
    fallbackLinkRoot && fallbackLinkRoot !== root
      ? linkResolver(fallbackLinkRoot)
      : undefined

  const tryFile = (b: string) => {
    const candidate = resolveTreeFile(b)

    if (!candidate) {return undefined}

    // canonicalize so a file reached via a symlink (e.g. a self-referencing linked package) dedups to one module.
    // guard the read: a candidate that turns out to be a directory or is otherwise unreadable is "not found", never a
    // thrown EISDIR/EACCES that would crash the compiler on a malformed import.
    try {
      return {
        file: realpathSync(candidate),
        text: readFileSync(candidate, 'utf8'),
      }
    } catch {
      return undefined
    }
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
      if (existsSync(path.join(dir, 'deck.tree'))) return safeReal(dir)
      const up = path.dirname(dir)
      if (up === dir) return rootReal
      dir = up
    }
  }

  const base: Resolver = (importPath, fromFile) => {
    // a relative import resolves against the importing file (the framework's modules import each other this way)
    if (importPath.startsWith('./') || importPath.startsWith('../')) {
      const resolved = path.resolve(path.dirname(fromFile), importPath)
      // confine: the resolved file must stay within the importer's package
      // (or the project root). Anything escaping both is treated as
      // not-found rather than read off the host filesystem.
      const bound = packageRootOf(fromFile)
      const resolvedReal = safeReal(resolved)
      if (!isWithin(resolvedReal, bound) && !isWithin(resolvedReal, rootReal)) {
        return undefined
      }
      return tryFile(resolved)
    }

    // linked packages first (@cluesurf/base, /bind, /term, /site via `seed link`): the project's own links, then the
    // CLI install's links, then the bundled stdlib fallback
    const fromLink =
      linked(importPath, fromFile) ??
      fallbackLinked?.(importPath, fromFile)

    if (fromLink) {return fromLink}

    const fromStdlib = stdlib?.(importPath, fromFile)

    if (fromStdlib) {return fromStdlib}

    // `@scope/pkg/sub/path` -> `<root>/code/sub/path.tree` when it refers to this project
    const segments = importPath
      .replace(/^@[^/]+\/[^/]+\//, '')
      .split('/')

    const candidate = path.join(
      root,
      'code',
      `${segments.join('/')}.tree`,
    )

    try {
      return { file: candidate, text: readFileSync(candidate, 'utf8') }
    } catch {
      return undefined
    }
  }

  return withNativeEnv(env, base)
}

// compile every .tree file in the project to TypeScript under `host/`, mirroring the source tree. An optional shared
// cache makes repeated builds (watch mode) incremental: an unchanged module reuses its parse + mill. Returns counts so
// the caller decides how to report and whether to fail.
export function compileProject(
  root: string,
  cache: CompileCache = projectCache(root),
): { compiled: number; failed: number; errors: string[] } {
  const files = findTreeFiles(root)
  const resolve = projectResolver(root)

  let compiled = 0
  let failed = 0

  const errors: string[] = []

  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const result = compile({ file, text }, { resolve, cache })

    if (!result.ok) {
      failed++

      const first = result.diagnostics[0]
      errors.push(
        `${path.relative(root, file)}: ${
          first ? `${first.name}: ${first.message}` : 'compile failed'
        }`,
      )
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

    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, isCss ? (result.css as string) : result.typescript)
    compiled++
  }

  return { compiled, failed, errors }
}

// watch the project's .tree files and recompile incrementally on change (a shared cache reuses unchanged modules).
// Debounced so a burst of saves triggers one rebuild. Runs until the process is killed.
export function watchProject(root: string): void {
  const cache = projectCache(root)

  const build = (label: string): void => {
    const { compiled, failed, errors } = compileProject(root, cache)

    for (const error of errors) {logFail(error)}

    if (failed > 0)
      {logFail(`${label}: ${compiled} ok, ${failed} failed`)}
    else
      {logGood(
        `${label}: ${compiled} file${
          compiled === 1 ? '' : 's'
        } -> host/`,
      )}
  }

  build('built')
  console.log(fade('  watching for changes... (ctrl-c to stop)'))

  let timer: ReturnType<typeof setTimeout> | undefined
  fsWatch(root, { recursive: true }, (_event, filename) => {
    const name = typeof filename === 'string' ? filename : ''

    if (!name.endsWith('.tree') || name.includes('host/')) {return}

    if (timer) {clearTimeout(timer)}

    timer = setTimeout(() => build(`rebuilt (${name})`), 30)
  })
}

export async function callMake(input: {
  root: string
  ride?: boolean
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

    if (hasMakeScript) {
      const args = input.ride ? ['run', 'scan'] : ['run', 'make']
      await runCommand({ cmd: 'pnpm', args, cwd: input.root })

      if (!input.ride) {
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
          '  No build script found. Compiling .tree files directly...',
        ),
      )

      const { compiled, failed, errors } = compileProject(input.root)

      for (const error of errors) {logFail(error)}

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
  // run through a shell (PATH lookup of script shims like `pnpm`). A long-running server (`seed boot`) sets this false
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
      if (child.pid === undefined) {return}

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
      if (killTimer) {clearTimeout(killTimer)}
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      process.off('exit', onParentExit)

      // a clean exit, or termination by a signal (ctrl-c), is not an error
      if (code === 0 || code === null || signal) {resolve()}
      else {reject(new Error(`Process exited with code ${code}`))}
    })

    child.on('error', err => {
      if (killTimer) {clearTimeout(killTimer)}
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      process.off('exit', onParentExit)
      reject(err)
    })
  })
}

export { runCommand }
