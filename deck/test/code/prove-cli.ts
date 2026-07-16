/**
 * `seed hold` - the terminal verification workflow as a standalone
 * runner. The reusable core lives in `prove-file.ts` (resolver-injected,
 * no `@cluesurf/call` dependency); this script supplies the project
 * resolver and the process glue (argv, output, exit code). The real
 * CLI verb is `@cluesurf/call/code/hold` (`seed hold`), which calls
 * the same `proveFile`. Usage:
 *   npx tsx deck/test/code/prove-cli.ts <file.tree> [--cross] [--json]
 *
 * Run from the seed install root so @cluesurf/seed imports resolve.
 */

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { projectResolver } from '@cluesurf/call/code/make'
import { proveFile, renderReport } from './prove-file'

export async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('seed-prove')
    .command('$0 <file>', 'verify a Seed file', y =>
      y
        .positional('file', { type: 'string', describe: 'the .tree file to verify' })
        .option('cross', { type: 'boolean', default: true, describe: 'run the cross-backend differential' })
        .option('json', { type: 'boolean', default: false, describe: 'machine-readable output' }),
    )
    .strict()
    .help()
    .parse()

  const file = String(argv.file)
  const root = process.cwd()
  const resolve = projectResolver(root, 'node', root)
  const report = proveFile({ file, resolve, cross: Boolean(argv.cross) })

  if (argv.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(renderReport(report))
  }

  process.exit(report.ok ? 0 : 1)
}

// run when invoked directly
const invokedDirectly = process.argv[1]?.endsWith('prove-cli.ts')
if (invokedDirectly) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(2)
  })
}
