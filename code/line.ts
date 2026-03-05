import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { showBanner, showInfo } from './show'
import { callLoad } from './call/load'
import { callSave } from './call/save'
import { callToss } from './call/toss'
import { callHost } from './call/host'
import { callSeek } from './call/seek'
import { callLink } from './call/link'
import { callMake } from './call/make'
import { callTest } from './call/test'
import { callBoot } from './call/boot'
import { callWash } from './call/wash'
import { callWalk } from './call/walk'
import { callMove } from './call/move'
import { callNote } from './call/note'
import { logFail } from './tint'

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
    'boot',
    'Start the app',
    () => {},
    async () => {
      await callBoot({ root })
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
    'show [what]',
    'Display information',
    yargs =>
      yargs.positional('what', {
        type: 'string',
        description: 'What to show (mark, deck, self)',
      }),
    async argv => {
      if (argv.what === 'mark') {
        const { loadManifest, showMark } = await import(
          '@cluesurf/deck.tree'
        )
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

  // if no command was given, show banner
  if (argv._.length === 0) {
    showBanner()
  }
}

main().catch(err => {
  logFail(err.message ?? String(err))
  process.exit(1)
})
