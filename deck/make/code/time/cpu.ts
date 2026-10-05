// CPU profiling. Runs the compiled program once in a child node process under V8's `--cpu-prof`, then reads the emitted
// `.cpuprofile`, attributes each sample's time delta to its call frame, and aggregates self-time per function. Reports
// the hottest functions. This profiles the compiled artifact's own hotspots (not the compiler).
//
// The attribution and the report are Term, time/profile.tree (self-hosting, 2026-10-04). This file is the process work.
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Resolver } from '@term/make/code/compile/load'
import {
  compileToModule,
  prepareModuleDir,
} from '@term/make/code/time/execute'
import { formatCpuResult, summarize } from '@term/make/code/time/profile'
import type { CpuFrame, CpuResult, V8Profile } from '@term/make/code/time/profile'

export { formatCpuResult }
export type { CpuFrame, CpuResult }

const HARNESS = `await import('./module.mjs')\n`

export async function runCpuProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
  top?: number
}): Promise<CpuResult> {
  const { code } = compileToModule({
    text: input.text,
    file: input.file,
    resolve: input.resolve,
  })

  const dir = await prepareModuleDir({
    root: input.root,
    code,
    tag: 'cpu',
  })

  await fs.writeFile(path.join(dir, 'harness.mjs'), HARNESS)

  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--cpu-prof',
        '--cpu-prof-dir',
        dir,
        '--cpu-prof-name',
        'run.cpuprofile',
        'harness.mjs',
      ],
      { cwd: dir },
    )

    let err = ''
    child.stderr.on('data', d => (err += String(d)))
    child.on('error', reject)
    child.on('close', code =>
      code === 0
        ? resolve()
        : reject(
            new Error(err.trim() || `node exited with code ${code}`),
          ),
    )
  })

  const raw = await fs.readFile(
    path.join(dir, 'run.cpuprofile'),
    'utf-8',
  )
  const profile = JSON.parse(raw) as V8Profile

  return summarize(profile, input.name, input.top ?? 15)
}
