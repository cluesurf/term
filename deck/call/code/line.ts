import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { showBanner, showInfo } from '@cluesurf/make/code/show'
import { callLoad } from '@cluesurf/call/code/load'
import { callSave } from '@cluesurf/call/code/save'
import { callToss } from '@cluesurf/call/code/toss'
import { callHost } from '@cluesurf/call/code/host'
import { callSeek } from '@cluesurf/call/code/seek'
import { callLink } from '@cluesurf/call/code/link'
import { callMake } from '@cluesurf/call/code/make'
import { callScan } from '@cluesurf/call/code/scan'
import { callMind } from '@cluesurf/call/code/mind'
import { callTest } from '@cluesurf/call/code/test'
import { callTime } from '@cluesurf/call/code/time'
import { callBoot } from '@cluesurf/call/code/boot'
import { callHalt } from '@cluesurf/call/code/halt'
import { callServe } from '@cluesurf/call/code/serve'
import { callDaemon } from '@cluesurf/call/code/daemon'
import { callWash } from '@cluesurf/call/code/wash'
import { callWalk } from '@cluesurf/call/code/walk'
import { callMove } from '@cluesurf/call/code/move'
import { callNote } from '@cluesurf/call/code/note'
import { callProfile } from '@cluesurf/call/code/profile'
import { callForm } from '@cluesurf/call/code/form'
import { callLint } from '@cluesurf/call/code/lint'
import { callHold } from '@cluesurf/call/code/hold'
import { callHunt } from '@cluesurf/call/code/hunt'
import { callLook } from '@cluesurf/call/code/look'
import { logFail, warn } from '@cluesurf/make/code/tint'

const COMMANDS = [
  'load',
  'save',
  'toss',
  'link',
  'seek',
  'host',
  'make',
  'scan',
  'mind',
  'test',
  'time',
  'profile',
  'boot',
  'halt',
  'serve',
  'daemon',
  'wash',
  'walk',
  'move',
  'note',
  'show',
  'form',
  'lint',
  'hold',
  'hunt',
  'look',
]

function editDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0),
  )

  for (let i = 0; i <= m; i++) {
    dp[i]![0] = i
  }

  for (let j = 0; j <= n; j++) {
    dp[0]![j] = j
  }

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + cost,
      )
    }
  }

  return dp[m]![n]!
}

function suggestCommand(input: string): string | undefined {
  let best: string | undefined
  let bestDist = Infinity

  for (const cmd of COMMANDS) {
    const dist = editDistance(input.toLowerCase(), cmd)

    if (dist < bestDist) {
      bestDist = dist
      best = cmd
    }
  }

  if (bestDist <= 2 && best) {
    return best
  }

  return undefined
}

const root = process.cwd()

const cli = yargs(hideBin(process.argv))
  .scriptName('seed')
  .usage('Usage: seed <verb> [objects] [options]')
  .option('hint', {
    alias: 'h',
    type: 'boolean',
    description: 'Show help',
  })
  .option('back', {
    alias: 'b',
    type: 'string',
    choices: ['json', 'link', 'line'] as const,
    default: 'line',
    description: 'Response format',
  })
  .command(
    'load',
    'Install all dependencies',
    yargs =>
      yargs
        .option('clean', {
          type: 'boolean',
          description: 'Clean install from scratch',
        })
        .option('offline', {
          type: 'boolean',
          description: 'Install without network',
        })
        .option('like', {
          type: 'string',
          description: 'Install subset (e.g. "base")',
        }),
    async argv => {
      await callLoad({
        root,
        clean: argv.clean,
        offline: argv.offline,
        like: argv.like,
      })
    },
  )
  .command(
    'save [deck]',
    'Add a dependency',
    yargs =>
      yargs.positional('deck', {
        type: 'string',
        description: 'Package name to add',
      }),
    async argv => {
      await callSave({
        root,
        deck: argv.deck,
      })
    },
  )
  .command(
    'toss [deck]',
    'Remove a dependency',
    yargs =>
      yargs.positional('deck', {
        type: 'string',
        description: 'Package name to remove',
      }),
    async argv => {
      await callToss({
        root,
        deck: argv.deck,
      })
    },
  )
  .command(
    'link [deck]',
    'Link a local package for development',
    yargs =>
      yargs.positional('deck', {
        type: 'string',
        description: 'Path to local package',
      }),
    async argv => {
      await callLink({
        root,
        deck: argv.deck,
      })
    },
  )
  .command(
    'seek',
    'Check if packages are installed correctly',
    () => {},
    async () => {
      await callSeek({ root })
    },
  )
  .command(
    'host',
    'Publish package to registry',
    yargs =>
      yargs.option('dry', {
        type: 'boolean',
        description: 'Dry run (no upload)',
      }),
    async argv => {
      await callHost({
        root,
        dryRun: argv.dry,
      })
    },
  )
  .command(
    'make',
    'Build/compile the project',
    yargs =>
      yargs.option('ride', {
        type: 'boolean',
        description: 'Watch and recompile',
      }),
    async argv => {
      await callMake({
        root,
        ride: argv.ride,
      })
    },
  )
  .command(
    'scan <file>',
    'Type-check a file and report diagnostics (the verifier)',
    yargs =>
      yargs.positional('file', {
        type: 'string',
        description: 'The .tree file to check',
        demandOption: true,
      }),
    async argv => {
      await callScan({
        root,
        file: argv.file,
        back: argv.back,
      })
    },
  )
  .command(
    'mind [fact]',
    'Project memory: remember a fact, or recall facts',
    yargs =>
      yargs
        .positional('fact', {
          type: 'string',
          description: 'A fact to remember (omit to recall)',
        })
        .option('name', {
          type: 'string',
          description: 'A short name for the fact',
        })
        .option('kind', {
          type: 'string',
          choices: [
            'decision',
            'convention',
            'constraint',
            'reference',
            'note',
          ] as const,
          description: 'The kind of fact',
        })
        .option('find', {
          type: 'string',
          description: 'Recall only facts matching this query',
        }),
    async argv => {
      await callMind({
        root,
        fact: argv.fact,
        name: argv.name,
        kind: argv.kind,
        find: argv.find,
        back: argv.back,
      })
    },
  )
  .command(
    'test [filter]',
    'Run tests',
    yargs =>
      yargs.positional('filter', {
        type: 'string',
        description: 'Filter tests',
      }),
    async argv => {
      await callTest({
        root,
        filter: argv.filter,
      })
    },
  )
  .command(
    'time [filter]',
    'Run benchmarks',
    yargs =>
      yargs
        .positional('filter', {
          type: 'string',
          description: 'Filter benchmarks by name',
        })
        .option('file', {
          type: 'string',
          description: 'Run benchmarks in a specific file',
        })
        .option('json', {
          type: 'boolean',
          description: 'Output JSON instead of table',
        })
        .option('save', {
          type: 'string',
          description: 'Save results as a named baseline',
        })
        .option('compare', {
          type: 'string',
          description: 'Compare against a saved baseline',
        })
        .option('fail-on-regression', {
          type: 'number',
          description:
            'Fail if any benchmark regresses by more than N%',
        })
        .option('markdown', {
          type: 'boolean',
          description: 'Output comparison as markdown',
        })
        .option('history', {
          type: 'string',
          description: 'Show history for a specific benchmark',
        }),
    async argv => {
      await callTime({
        root,
        filter: argv.filter,
        file: argv.file,
        json: argv.json,
        save: argv.save,
        compare: argv.compare,
        failOnRegression: argv['fail-on-regression'],
        markdown: argv.markdown,
        history: argv.history,
      })
    },
  )
  .command(
    'profile <mode> <file>',
    'Profile CPU or memory usage',
    yargs =>
      yargs
        .positional('mode', {
          type: 'string',
          description: 'Profile mode: cpu or memory',
        })
        .positional('file', {
          type: 'string',
          description: 'File to profile',
        })
        .option('flame', {
          type: 'boolean',
          description: 'Show flamegraph instructions',
        })
        .option('top', {
          type: 'number',
          description: 'Show top-N hottest functions',
        })
        .option('time', {
          type: 'boolean',
          description: 'Profile time blocks only',
        })
        .option('heap', {
          type: 'boolean',
          description: 'Capture heap snapshot',
        })
        .option('track', {
          type: 'boolean',
          description: 'Record memory timeline',
        }),
    async argv => {
      await callProfile({
        root,
        mode: argv.mode!,
        file: argv.file!,
        flame: argv.flame,
        top: argv.top,
        time: argv.time,
        heap: argv.heap,
        track: argv.track,
      })
    },
  )
  .command(
    'boot [entry]',
    'Compile and run an app (entry, or the deck.tree boot entry)',
    yargs =>
      yargs
        .positional('entry', {
          type: 'string',
          description:
            'Entry .tree module (defaults to deck.tree boot)',
        })
        .option('port', {
          alias: 'p',
          type: 'number',
          description: 'Port to serve on',
        })
        .option('env', {
          type: 'string',
          description: 'Target env (node, browser)',
        })
        .option('remote', {
          type: 'string',
          description:
            'Remote cache endpoint (pull before, push after)',
        })
        .option('remote-token', {
          type: 'string',
          description: 'Bearer token for the remote cache',
        }),
    async argv => {
      await callBoot({
        root,
        entry: argv.entry,
        port: argv.port,
        env: argv.env as never,
        remote: argv.remote,
        remoteToken: argv['remote-token'],
      })
    },
  )
  .command(
    'halt',
    'Stop running seed boot servers (all, or specific --port list)',
    yargs =>
      yargs.option('port', {
        alias: 'p',
        type: 'string',
        description: 'Comma-separated ports to stop (default: all)',
      }),
    async argv => {
      const ports = argv.port
        ? String(argv.port)
            .split(',')
            .map(p => Number(p.trim()))
            .filter(p => Number.isInteger(p) && p > 0)
        : undefined

      await callHalt({ ports })
    },
  )
  .command(
    'serve [entry]',
    'Start the dev server (lazy ESM + hot reload)',
    yargs =>
      yargs
        .positional('entry', {
          type: 'string',
          description:
            'Entry .tree module (defaults to deck.tree boot)',
        })
        .option('port', {
          alias: 'p',
          type: 'number',
          description: 'Port to serve on',
        })
        .option('env', { type: 'string', description: 'Target env' }),
    async argv => {
      await callServe({
        root,
        entry: argv.entry,
        port: argv.port,
        env: argv.env as never,
      })
    },
  )
  .command(
    'daemon',
    'Run the long-lived compiler daemon (shared warm analyzer)',
    yargs =>
      yargs
        .option('port', {
          alias: 'p',
          type: 'number',
          description: 'Port to serve on',
        })
        .option('env', { type: 'string', description: 'Target env' }),
    async argv => {
      await callDaemon({
        root,
        port: argv.port,
        env: argv.env as never,
      })
    },
  )
  .command(
    'wash [target]',
    'Clean build artifacts',
    yargs =>
      yargs.positional('target', {
        type: 'string',
        description: 'What to clean (deck, tail)',
      }),
    async argv => {
      await callWash({
        root,
        target: argv.target,
      })
    },
  )
  .command(
    'walk',
    'Start REPL',
    () => {},
    async () => {
      await callWalk({ root })
    },
  )
  .command(
    'move <target> [level]',
    'Version management',
    yargs =>
      yargs
        .positional('target', {
          type: 'string',
          description: 'What to move (mark)',
        })
        .positional('level', {
          type: 'string',
          description: 'Bump level: 1=major, 2=minor, 3=patch',
        }),
    async argv => {
      await callMove({
        root,
        target: argv.target,
        level: argv.level,
      })
    },
  )
  .command(
    'note [deck]',
    'Show package info',
    yargs =>
      yargs.positional('deck', {
        type: 'string',
        description: 'Package to inspect',
      }),
    async argv => {
      await callNote({
        root,
        deck: argv.deck,
      })
    },
  )
  .command(
    'form [paths..]',
    'Format .tree files into canonical layout',
    yargs =>
      yargs
        .positional('paths', {
          type: 'string',
          description:
            'Files or directories to format (default: current directory)',
        })
        .option('check', {
          type: 'boolean',
          description:
            'Report which files would change without writing (for CI)',
        })
        .option('list', {
          type: 'boolean',
          description:
            'Print formatted source to stdout instead of writing',
        }),
    async argv => {
      await callForm({
        root,
        paths: (argv.paths as string[] | undefined) ?? [],
        check: argv.check,
        list: argv.list,
      })
    },
  )
  .command(
    'look [target]',
    'Inspect what a module exposes (forms + tasks), following its load/bear graph',
    yargs =>
      yargs
        .positional('target', {
          type: 'string',
          description:
            'A package path (@cluesurf/bind/code/browser/dom) or a .tree file',
        })
        .option('json', { type: 'boolean', description: 'Output JSON' })
        .option('csv', { type: 'boolean', description: 'Output CSV' })
        .option('kind', {
          type: 'string',
          choices: ['form', 'task'] as const,
          description: 'Only forms or only tasks',
        }),
    async argv => {
      await callLook({
        root,
        target: argv.target,
        json: argv.json,
        csv: argv.csv,
        kind: argv.kind,
      })
    },
  )
  .command(
    'lint [paths..]',
    'Lint .tree files for style and correctness',
    yargs =>
      yargs
        .positional('paths', {
          type: 'string',
          description:
            'Files or directories to lint (default: current directory)',
        })
        .option('fix', {
          type: 'boolean',
          description: 'Apply autofixes in place',
        }),
    async argv => {
      await callLint({
        root,
        paths: (argv.paths as string[] | undefined) ?? [],
        fix: argv.fix,
      })
    },
  )
  .command(
    'hold [paths..]',
    'Verify .tree files hold: report gaps, run the cross-backend differential, gate CI (incremental)',
    yargs =>
      yargs
        .positional('paths', {
          type: 'string',
          description:
            'Files or directories to verify (default: current directory)',
        })
        .option('cross', {
          type: 'boolean',
          default: true,
          description: 'Run the cross-backend differential',
        })
        .option('cache', {
          type: 'boolean',
          default: true,
          description: 'Skip files unchanged since they last held',
        })
        .option('force', {
          type: 'boolean',
          description: 'Re-check everything, ignoring the cache',
        })
        .option('json', {
          type: 'boolean',
          description: 'Machine-readable output',
        }),
    async argv => {
      await callHold({
        root,
        paths: (argv.paths as string[] | undefined) ?? [],
        cross: argv.cross,
        cache: argv.cache,
        force: argv.force,
        json: argv.json,
      })
    },
  )
  .command(
    'hunt [glob]',
    'Automated bug-hunt: oracles + fuzzing over .tree files (crashes, hangs, round-trip, determinism, cross-backend, perf)',
    yargs =>
      yargs
        .positional('glob', {
          type: 'string',
          description:
            'Directory of .tree files to hunt (default: deck/base/code)',
        })
        .option('runs', {
          type: 'number',
          description: 'Fuzz inputs per seed',
        })
        .option('seeds', {
          type: 'number',
          description: 'Distinct fuzz seeds',
        })
        .option('fuzz-timeout', {
          type: 'number',
          description: 'Watchdog seconds per fuzz seed',
        })
        .option('json', {
          type: 'boolean',
          description: 'Machine-readable output',
        }),
    async argv => {
      await callHunt({
        root,
        glob: argv.glob,
        runs: argv.runs,
        seeds: argv.seeds,
        fuzzTimeout: argv.fuzzTimeout,
        json: argv.json,
      })
    },
  )
  .command(
    'show [what]',
    'Display information',
    yargs =>
      yargs.positional('what', {
        type: 'string',
        description: 'What to show (mark, deck, self)',
      }),
    async argv => {
      if (argv.what === 'mark') {
        const { loadManifest, showMark } =
          await import('@cluesurf/deck.tree')

        try {
          const manifest = await loadManifest({ dir: root })
          console.log(showMark(manifest.mark))
        } catch {
          logFail('No deck.tree found')
        }
      } else {
        showInfo()
      }
    },
  )
  .demandCommand(0)
  .strict(false)
  .fail((msg, err) => {
    if (err) {
      logFail(err.message)
    } else if (msg) {
      logFail(msg)
    }

    process.exit(1)
  })
  .version(false)

async function main(): Promise<void> {
  const argv = await cli.parse()

  if (argv._.length === 0) {
    showBanner()

    return
  }

  const cmd = String(argv._[0])

  if (!COMMANDS.includes(cmd)) {
    const suggestion = suggestCommand(cmd)

    if (suggestion) {
      logFail(
        `Unknown command "${cmd}". Did you mean ${warn(
          `seed ${suggestion}`,
        )}?`,
      )
    } else {
      logFail(
        `Unknown command "${cmd}". Run "seed" for a list of commands.`,
      )
    }

    process.exit(1)
  }
}

main().catch(err => {
  logFail(err.message ?? String(err))
  process.exit(1)
})
