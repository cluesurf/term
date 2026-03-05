import { spawn } from 'child_process'
import path from 'path'
import { logGood, logFail, logStep, formatError, fade } from '../tint'

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
    } else {
      console.log(fade('  No build script found. Looking for .tree files...'))
      // TODO: invoke mesh.tree compiler directly
      logFail('Compiler not yet integrated. Add a "make" script to package.json.')
      process.exit(1)
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
