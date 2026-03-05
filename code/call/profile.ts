import * as fs from 'fs/promises'
import * as path from 'path'
import { logGood, logFail, logStep, logWarn, formatError } from '../tint'

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
      await profileCpu({ root, filePath, flame: input.flame, top: input.top, timeOnly: input.time })
      break
    case 'memory':
      await profileMemory({ root, filePath, heap: input.heap, track: input.track })
      break
    default:
      logFail(`Unknown profile mode: ${mode}. Use "cpu" or "memory".`)
      process.exit(1)
  }
}

async function profileCpu(input: {
  root: string
  filePath: string
  flame?: boolean
  top?: number
  timeOnly?: boolean
}): Promise<void> {
  logStep('CPU profiling...')

  try {
    const { captureProfile, serializeProfile, extractHotspots, formatHotspots } = await import(
      '@cluesurf/mesh.tree/code/time/profile'
    )
    const { compileText } = await import('@cluesurf/mesh.tree/code/make')
    const { parse } = await import('@cluesurf/tree')

    const text = await fs.readFile(input.filePath, 'utf-8')

    const compiled = compileText({
      text,
      file: input.filePath,
      target: 'typescript',
      parse,
    })

    if (compiled.errors.length > 0) {
      logFail(`${compiled.errors.length} compilation errors`)
      process.exit(1)
    }

    // Build the function to profile
    const fn = new Function(compiled.code + '\n// entry') as () => void

    const profile = await captureProfile({
      run: fn,
      samplingInterval: 100,
    })

    if (input.top) {
      const hotspots = extractHotspots({ profile, limit: input.top })
      console.log('')
      console.log(formatHotspots(hotspots))
      console.log('')
    }

    // Save .cpuprofile
    const outPath = input.filePath.replace(/\.tree$/, '.cpuprofile')
    await fs.writeFile(outPath, serializeProfile(profile))
    logGood(`Profile saved to ${outPath}`)

    if (input.flame) {
      logStep('Open the .cpuprofile file in speedscope or Chrome DevTools for flamegraph visualization')
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}

async function profileMemory(input: {
  root: string
  filePath: string
  heap?: boolean
  track?: boolean
}): Promise<void> {
  logStep('Memory profiling...')

  try {
    const { profileMemory: runMemProfile, recordTimeline, formatMemoryResult, formatTimelineCsv } = await import(
      '@cluesurf/mesh.tree/code/time/memory'
    )
    const { compileText } = await import('@cluesurf/mesh.tree/code/make')
    const { parse } = await import('@cluesurf/tree')

    const text = await fs.readFile(input.filePath, 'utf-8')

    const compiled = compileText({
      text,
      file: input.filePath,
      target: 'typescript',
      parse,
    })

    if (compiled.errors.length > 0) {
      logFail(`${compiled.errors.length} compilation errors`)
      process.exit(1)
    }

    const fn = new Function(compiled.code + '\n// entry') as () => void

    if (input.track) {
      const timeline = recordTimeline({ run: fn })
      const csvPath = input.filePath.replace(/\.tree$/, '.memory.csv')
      await fs.writeFile(csvPath, formatTimelineCsv(timeline))
      logGood(`Memory timeline saved to ${csvPath}`)
    } else {
      const result = runMemProfile({
        name: path.basename(input.filePath, '.tree'),
        run: fn,
        forceGc: true,
      })
      console.log('')
      console.log(formatMemoryResult(result))
      console.log('')
    }
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
