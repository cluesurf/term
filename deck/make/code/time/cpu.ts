// CPU profiling. Runs the compiled program once in a child node process under V8's `--cpu-prof`, then reads the emitted
// `.cpuprofile`, attributes each sample's time delta to its call frame, and aggregates self-time per function. Reports
// the hottest functions. This profiles the compiled artifact's own hotspots (not the compiler).
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  compileToModule,
  prepareModuleDir,
} from '@cluesurf/make/code/time/execute'

export type CpuFrame = {
  name: string
  location: string
  self_ms: number
  total_ms: number
}

export type CpuResult = {
  name: string
  duration_ms: number
  sample_count: number
  frames: CpuFrame[]
}

const HARNESS = `await import('./module.mjs')\n`

// a V8 .cpuprofile, the subset we read
type V8Profile = {
  nodes: {
    id: number
    callFrame: {
      functionName: string
      url: string
      lineNumber: number
    }
    hitCount?: number
    children?: number[]
  }[]
  startTime: number
  endTime: number
  samples: number[]
  timeDeltas: number[]
}

export async function runCpuProfile(input: {
  text: string
  file: string
  root: string
  name: string
  top?: number
}): Promise<CpuResult> {
  const { code } = compileToModule({
    text: input.text,
    file: input.file,
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

  return summarize({ profile, name: input.name, top: input.top ?? 15 })
}

// attribute each sample's elapsed time to the node it landed on (self-time), aggregate by call frame, and rank. Skip
// V8's synthetic frames (the profiler root, GC, program, idle) so user / runtime functions surface.
function summarize(input: {
  profile: V8Profile
  name: string
  top: number
}): CpuResult {
  const { profile } = input
  const byId = new Map<number, V8Profile['nodes'][number]>()

  for (const node of profile.nodes) {
    byId.set(node.id, node)
  }

  const selfMs = new Map<number, number>()

  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i]!
    const deltaMicroseconds = profile.timeDeltas[i] ?? 0
    selfMs.set(id, (selfMs.get(id) ?? 0) + deltaMicroseconds / 1000)
  }

  const synthetic = new Set([
    '(root)',
    '(program)',
    '(idle)',
    '(garbage collector)',
  ])

  const aggregate = new Map<
    string,
    { name: string; location: string; self_ms: number }
  >()

  for (const [id, ms] of selfMs) {
    const node = byId.get(id)

    if (!node) {
      continue
    }

    const functionName = node.callFrame.functionName || '(anonymous)'

    if (synthetic.has(functionName)) {
      continue
    }

    const file = node.callFrame.url
      ? path.basename(node.callFrame.url)
      : 'native'
    const location = `${file}:${node.callFrame.lineNumber + 1}`
    const key = `${functionName}@${location}`
    const entry = aggregate.get(key) ?? {
      name: functionName,
      location,
      self_ms: 0,
    }
    entry.self_ms += ms
    aggregate.set(key, entry)
  }

  const frames: CpuFrame[] = Array.from(aggregate.values())
    .map(e => ({
      name: e.name,
      location: e.location,
      self_ms: e.self_ms,
      total_ms: e.self_ms,
    }))
    .sort((a, b) => b.self_ms - a.self_ms)
    .slice(0, input.top)

  return {
    name: input.name,
    duration_ms: (profile.endTime - profile.startTime) / 1000,
    sample_count: profile.samples.length,
    frames,
  }
}

export function formatCpuResult(result: CpuResult): string {
  const lines: string[] = []

  lines.push(
    `${result.name}: ${result.duration_ms.toFixed(1)}ms wall, ${result.sample_count} samples`,
  )
  lines.push('')

  if (result.frames.length === 0) {
    lines.push('  (no user frames sampled; the run was too short)')

    return lines.join('\n')
  }

  const width = Math.max(...result.frames.map(f => f.name.length), 8)

  lines.push(
    `  ${'function'.padEnd(width)}  ${'self'.padStart(9)}  location`,
  )

  for (const frame of result.frames) {
    lines.push(
      `  ${frame.name.padEnd(width)}  ${`${frame.self_ms.toFixed(1)}ms`.padStart(9)}  ${frame.location}`,
    )
  }

  return lines.join('\n')
}
