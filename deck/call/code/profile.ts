import * as fs from 'fs/promises'
import * as path from 'path'
import {
  logGood,
  logFail,
  logStep,
  logWarn,
  formatError,
} from '@cluesurf/make/code/tint'
import { render } from '@cluesurf/make/code/parser/diagnostic'
import {
  compileToModule,
  CompileFailure,
} from '@cluesurf/make/code/time/execute'
import {
  runMemoryProfile,
  formatMemoryResult,
} from '@cluesurf/make/code/time/memory'

export async function callProfile(input: {
  root: string
  mode: string
  file: string
  flame?: boolean
  top?: number
  time?: boolean
  heap?: boolean
  track?: boolean
}): Promise<void> {
  const { root, mode, file } = input
  const filePath = path.resolve(root, file)

  try {
    await fs.access(filePath)
  } catch {
    logFail(`File not found: ${file}`)
    process.exit(1)
  }

  switch (mode) {
    case 'cpu':
      await profileCpu({ root, filePath })
      break
    case 'memory':
      await profileMemory({ root, filePath, track: input.track })
      break
    default:
      logFail(`Unknown profile mode: ${mode}. Use "cpu" or "memory".`)
      process.exit(1)
  }
}

// CPU profiling of the compiled artifact's own hotspots is not wired yet. We still compile the file so the user gets
// real feedback if it does not build, then point them at memory profiling, which is available.
async function profileCpu(input: {
  root: string
  filePath: string
}): Promise<void> {
  logStep('CPU profiling...')
  const text = await fs.readFile(input.filePath, 'utf-8')
  try {
    compileToModule({
      text,
      file: path.relative(input.root, input.filePath),
    })
  } catch (err) {
    if (err instanceof CompileFailure) {
      logFail(`${err.diagnostics.length} compilation error(s)`)
      for (const diagnostic of err.diagnostics)
        console.error(render(diagnostic, text.split('\n')))
      process.exit(1)
    }
    throw err
  }
  logWarn(
    'CPU profiling is not available yet. The file compiles. Use `seed profile memory <file>` for now.',
  )
}

async function profileMemory(input: {
  root: string
  filePath: string
  track?: boolean
}): Promise<void> {
  logStep('Memory profiling...')
  if (input.track)
    logWarn(
      'Timeline tracking is not available yet; reporting a single before/after measurement.',
    )

  const text = await fs.readFile(input.filePath, 'utf-8')
  try {
    const result = await runMemoryProfile({
      text,
      file: path.relative(input.root, input.filePath),
      root: input.root,
      name: path.basename(input.filePath, '.tree'),
    })
    console.log('')
    console.log(formatMemoryResult(result))
    console.log('')
    logGood('Memory profile complete')
  } catch (err) {
    if (err instanceof CompileFailure) {
      logFail(`${err.diagnostics.length} compilation error(s)`)
      for (const diagnostic of err.diagnostics)
        console.error(render(diagnostic, text.split('\n')))
      process.exit(1)
    }
    logFail(formatError(err))
    process.exit(1)
  }
}
