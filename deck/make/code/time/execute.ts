// Compiled execution primitives. We never interpret: we compile a `.tree` file to TypeScript, strip the types to an
// ES module (esbuild `transform`, build-time codegen), write it to a temp directory, and run it with plain `node` in
// a child process. The benchmark and memory-profile commands both build on this. No `eval`, no interpreter.

import { compile } from '@cluesurf/make/code/compile/compile'
import type { Program } from '@cluesurf/make/code/compile/node'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

export class CompileFailure extends Error {
  constructor(public diagnostics: Array<Diagnostic>) {
    super('compilation failed')
  }
}

// compile a self-contained `.tree` file to a runnable TypeScript module plus its checked program (for discovery).
export function compileToModule(input: {
  text: string
  file: string
}): { code: string; program: Program } {
  const result = compile({ file: input.file, text: input.text })
  if (!result.ok) throw new CompileFailure(result.diagnostics)
  return { code: result.typescript, program: result.program }
}

// transpile the emitted TypeScript to an ES module and write it into a fresh temp directory under the project. Returns
// the directory; the caller writes a `harness.mjs` beside `module.mjs` and runs it.
export async function prepareModuleDir(input: {
  root: string
  code: string
  tag: string
}): Promise<string> {
  const { transform } = await import('esbuild')
  const js = (
    await transform(input.code, {
      loader: 'ts',
      format: 'esm',
      target: 'node18',
    })
  ).code
  const dir = path.join(
    input.root,
    '.seed',
    'tmp',
    `${input.tag}-${process.pid}-${Date.now()}`,
  )
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'module.mjs'), js)
  return dir
}

// run an ES module with the current `node` binary and return its stdout. `gc` exposes `global.gc` for memory work.
export function runNode(input: {
  file: string
  cwd: string
  gc?: boolean
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = input.gc ? ['--expose-gc', input.file] : [input.file]
    const child = spawn(process.execPath, args, { cwd: input.cwd })
    let out = ''
    let err = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code =>
      code === 0
        ? resolve(out)
        : reject(
            new Error(err.trim() || `node exited with code ${code}`),
          ),
    )
  })
}

export async function cleanupDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}
