import { spawn } from 'child_process'
import path from 'path'
import { readdirSync, statSync, mkdirSync, writeFileSync, readFileSync, watch as fsWatch } from 'fs'
import { compile } from '../compile/compile'
import { CompileCache } from '../compile/cache'
import { withNativeEnv } from '../compile/native'
import type { NativeEnv } from '../compile/native'
import type { Resolver } from '../compile/load'
import { stdlibResolver, linkResolver } from './walk'
import { logGood, logFail, logStep, formatError, fade } from '../tint'

// every .tree file under a directory, skipping generated output and dependency / vcs folders
function findTreeFiles(dir: string, out: Array<string> = []): Array<string> {
  let entries: Array<string>
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'host' || entry === '.git') continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) findTreeFiles(full, out)
    else if (entry.endsWith('.tree')) out.push(full)
  }
  return out
}

// the resolver a project build uses: the bundled stdlib (`@cluesurf/base/...`) plus the project's own `.tree` files,
// wrapped so abstract native imports resolve to the target platform's implementation (default node)
export function projectResolver(root: string, env: NativeEnv = 'node'): Resolver {
  const stdlib = stdlibResolver()
  const linked = linkResolver(root)
  const base: Resolver = (importPath, fromFile) => {
    // linked packages first (@cluesurf/base, /bind, /term, /site via `seed link`), then the bundled stdlib fallback
    const fromLink = linked(importPath, fromFile)
    if (fromLink) return fromLink
    const fromStdlib = stdlib?.(importPath, fromFile)
    if (fromStdlib) return fromStdlib
    // `@scope/pkg/sub/path` -> `<root>/code/sub/path.tree` when it refers to this project
    const segments = importPath.replace(/^@[^/]+\/[^/]+\//, '').split('/')
    const candidate = path.join(root, 'code', `${segments.join('/')}.tree`)
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
export function compileProject(root: string, cache?: CompileCache): { compiled: number; failed: number; errors: Array<string> } {
  const files = findTreeFiles(root)
  const resolve = projectResolver(root)
  let compiled = 0
  let failed = 0
  const errors: Array<string> = []
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const result = compile({ file, text }, { resolve, cache })
    if (!result.ok) {
      failed++
      const first = result.diagnostics[0]
      errors.push(`${path.relative(root, file)}: ${first ? `${first.name}: ${first.message}` : 'compile failed'}`)
      continue
    }
    const outPath = path.join(root, 'host', path.relative(root, file).replace(/\.tree$/, '.ts'))
    mkdirSync(path.dirname(outPath), { recursive: true })
    writeFileSync(outPath, result.typescript)
    compiled++
  }
  return { compiled, failed, errors }
}

// watch the project's .tree files and recompile incrementally on change (a shared cache reuses unchanged modules).
// Debounced so a burst of saves triggers one rebuild. Runs until the process is killed.
export function watchProject(root: string): void {
  const cache = new CompileCache()
  const build = (label: string): void => {
    const { compiled, failed, errors } = compileProject(root, cache)
    for (const error of errors) logFail(error)
    if (failed > 0) logFail(`${label}: ${compiled} ok, ${failed} failed`)
    else logGood(`${label}: ${compiled} file${compiled === 1 ? '' : 's'} -> host/`)
  }
  build('built')
  console.log(fade('  watching for changes... (ctrl-c to stop)'))
  let timer: ReturnType<typeof setTimeout> | undefined
  fsWatch(root, { recursive: true }, (_event, filename) => {
    const name = typeof filename === 'string' ? filename : ''
    if (!name.endsWith('.tree') || name.includes('host/')) return
    if (timer) clearTimeout(timer)
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
      console.log(fade('  No build script found. Watching .tree files (incremental)...'))
      watchProject(input.root) // runs until interrupted
    } else {
      console.log(fade('  No build script found. Compiling .tree files directly...'))
      const { compiled, failed, errors } = compileProject(input.root)
      for (const error of errors) logFail(error)
      if (failed > 0) {
        logFail(`Compiled ${compiled} file${compiled === 1 ? '' : 's'}, ${failed} failed.`)
        process.exit(1)
      }
      if (compiled === 0) {
        console.log(fade('  No .tree files found.'))
      } else {
        logGood(`Compiled ${compiled} file${compiled === 1 ? '' : 's'} to host/`)
      }
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

function runCommand(input: {
  cmd: string
  args: Array<string>
  cwd: string
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.cmd, input.args, {
      cwd: input.cwd,
      stdio: 'inherit',
      shell: true,
    })

    child.on('close', code => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`Process exited with code ${code}`))
      }
    })

    child.on('error', reject)
  })
}

export { runCommand }
