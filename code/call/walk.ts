import { logFail, logStep, formatError } from '../tint'
import { runCommand } from './make'

export async function callWalk(input: {
  root: string
}): Promise<void> {
  logStep('Starting REPL...')

  try {
    // for now, start a Node REPL
    // TODO: start a Seed-native REPL when the runtime supports it
    await runCommand({ cmd: 'node', args: [], cwd: input.root })
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
