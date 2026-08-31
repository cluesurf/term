import { readFileSync } from 'node:fs'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { showBanner, showInfo } from '@term/make/code/show'
import { callLoad } from '@term/call/code/load'
import { callSave } from '@term/call/code/save'
import { callZone } from '@term/call/code/zone'
import { callToss } from '@term/call/code/toss'
import { callHost } from '@term/call/code/host'
import { callSeek } from '@term/call/code/seek'
import { callLink } from '@term/call/code/link'
import { callMake } from '@term/call/code/make'
import { callScan } from '@term/call/code/scan'
import { callMind } from '@term/call/code/mind'
import { callTest } from '@term/call/code/test'
import { callTime } from '@term/call/code/time'
import { callBoot } from '@term/call/code/boot'
import { callCast } from '@term/call/code/cast'
import { callHalt } from '@term/call/code/halt'
import { callFeed } from '@term/call/code/feed'
import { callWork } from '@term/call/code/work'
import { callWake } from '@term/call/code/wake'
import { callWash } from '@term/call/code/wash'
import { callWalk } from '@term/call/code/walk'
import { callMove } from '@term/call/code/move'
import { callNote } from '@term/call/code/note'
import { callForm } from '@term/call/code/form'
import { callLint } from '@term/call/code/lint'
import { callHold } from '@term/call/code/hold'
import { callHunt } from '@term/call/code/hunt'
import { callLook } from '@term/call/code/look'
import { callRoll } from '@term/call/code/roll'
import { callMold } from '@term/call/code/mold'
import { callView } from '@term/call/code/view'
import { logFail, warn } from '@term/make/code/tint'
import {
  callBaseCheck,
  callBaseCheckout,
  callBaseCommit,
  callBaseDiff,
  callBaseExport,
  callBaseInit,
  callBaseList,
  callBaseLog,
  callBaseMerge,
  callBaseProject,
  callBaseShow,
  callBaseStatus,
  callBaseTag,
} from '@term/call/code/base'
import { callBaseImport } from '@term/call/code/base-import'

const COMMANDS = [
  'base',
  'wake',
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
  'boot',
  'cast',
  'halt',
  'feed',
  'work',
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
  'roll',
  'mold',
  'view',
  'zone',
  'fill',
]

// the published version, read from this package's manifest at runtime (the bundled entry sits at host/line.js, so the
// manifest is one directory up)
function readVersion(): string {
  try {
    const manifest = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    )

    return String(manifest.version ?? '0.0.0')
  } catch {
    return '0.0.0'
  }
}

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
  .scriptName('term')
  .usage('Usage: term <verb> [objects] [options]')
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
  .command('base', 'The base record system', yargs =>
    yargs
      .command('init', 'Create a repository here', {}, () => {
        callBaseInit({ root })
      })
      .command(
        'log [branch]',
        'Commits per branch, newest first',
        y =>
          y.positional('branch', {
            type: 'string',
            description: 'one branch, or omit for all',
          }),
        argv => {
          callBaseLog({ root, ...(argv.branch ? { branch: argv.branch } : {}) })
        },
      )
      .command(
        'diff <to> [from]',
        'Field-level changes between two commits',
        y =>
          y
            .positional('to', { type: 'string', demandOption: true })
            .positional('from', {
              type: 'string',
              description: 'omit to diff from empty',
            }),
        argv => {
          callBaseDiff({
            root,
            to: String(argv.to),
            ...(argv.from ? { from: String(argv.from) } : {}),
          })
        },
      )
      .command(
        'show <commit> <mark>',
        'One record in canonical form, which is what is hashed',
        y =>
          y
            .positional('commit', { type: 'string', demandOption: true })
            .positional('mark', { type: 'string', demandOption: true }),
        argv => {
          callBaseShow({
            root,
            commit: String(argv.commit),
            mark: String(argv.mark),
          })
        },
      )
      .command(
        'list <commit>',
        'Every record at a commit',
        y => y.positional('commit', { type: 'string', demandOption: true }),
        argv => {
          callBaseList({ root, commit: String(argv.commit) })
        },
      )
      .command('check', 'Whether the repository is coherent', {}, () => {
        callBaseCheck({ root })
      })
      .command(
        'status [branch]',
        'What the working files would change',
        y => y.positional('branch', { type: 'string', default: 'main' }),
        argv => {
          callBaseStatus({ root, branch: String(argv.branch) })
        },
      )
      .command(
        'commit <message>',
        'Commit the working files onto a branch',
        y =>
          y
            .positional('message', { type: 'string', demandOption: true })
            .option('branch', { type: 'string', default: 'main' })
            .option('author', { type: 'string', default: 'anonymous' }),
        argv => {
          callBaseCommit({
            root,
            branch: String(argv.branch),
            message: String(argv.message),
            author: String(argv.author),
          })
        },
      )
      .command(
        'checkout <commit>',
        'Write a commit back out as .tree files',
        y => y.positional('commit', { type: 'string', demandOption: true }),
        argv => {
          callBaseCheckout({ root, commit: String(argv.commit) })
        },
      )
      .command(
        'merge <from>',
        'Merge a branch into another',
        y =>
          y
            .positional('from', { type: 'string', demandOption: true })
            .option('into', { type: 'string', default: 'main' })
            .option('author', { type: 'string', default: 'anonymous' }),
        argv => {
          callBaseMerge({
            root,
            from: String(argv.from),
            into: String(argv.into),
            author: String(argv.author),
          })
        },
      )
      .command(
        'export <commit>',
        'Write the working tree at a commit as .tree files',
        y =>
          y
            .positional('commit', { type: 'string', demandOption: true })
            .option('out', { type: 'string', demandOption: true }),
        argv => {
          callBaseExport({
            root,
            commit: String(argv.commit),
            out: String(argv.out),
          })
        },
      )
      .command(
        'import <source>',
        'Bring a csv, tsv, json or jsonl file, or a directory of them, in as records',
        y =>
          y
            .positional('source', { type: 'string', demandOption: true })
            .option('form', {
              type: 'string',
              demandOption: true,
              describe: 'the record form these rows are instances of',
            })
            .option('key', {
              type: 'string',
              describe:
                'a column that identifies a row in the source. The mark is found or created against it, so a re-import updates rather than duplicates',
            })
            .option('mark', {
              type: 'string',
              describe: 'a column that already holds a uuid version 4, used as the mark',
            })
            .option('branch', { type: 'string', default: 'main' })
            .option('author', { type: 'string', default: 'import' })
            .option('message', { type: 'string' }),
        argv => {
          callBaseImport({
            root,
            source: String(argv.source),
            form: String(argv.form),
            ...(argv.key === undefined ? {} : { key: String(argv.key) }),
            ...(argv.mark === undefined ? {} : { mark: String(argv.mark) }),
            branch: String(argv.branch),
            author: String(argv.author),
            ...(argv.message === undefined
              ? {}
              : { message: String(argv.message) }),
          })
        },
      )
      .command(
        'project <commit>',
        'What a projection would write, and with --into --write, write it',
        y =>
          y
            .positional('commit', { type: 'string', demandOption: true })
            .option('mapping', {
              type: 'string',
              describe:
                'a mapping file, for an existing schema. Left out, the schema is worked out from the records and the tables are created',
            })
            .option('into', {
              type: 'string',
              describe: 'a Postgres connection url to write the projection into',
            })
            // `--write`, not `--commit`, only because `commit` is already this verb's
            // POSITIONAL. The rule it follows is the house one either way: reports by
            // default, writes only when asked, so forgetting the flag is the safe direction.
            .option('write', {
              type: 'boolean',
              default: false,
              describe: 'actually write. Without it nothing is touched',
            })
            .option('repository', {
              type: 'string',
              describe:
                'the name this projection is bookkept under. Defaults to the directory name',
            }),
        async argv => {
          await callBaseProject({
            root,
            commit: String(argv.commit),
            ...(argv.mapping === undefined
              ? {}
              : { mapping: String(argv.mapping) }),
            ...(argv.into === undefined ? {} : { into: String(argv.into) }),
            commitWrite: Boolean(argv.write),
            ...(argv.repository === undefined
              ? {}
              : { repository: String(argv.repository) }),
          })
        },
      )
      .command(
        'tag <name> [commit]',
        'Name a commit, so it can be cited',
        y =>
          y
            .positional('name', { type: 'string', demandOption: true })
            .positional('commit', { type: 'string' })
            .option('branch', { type: 'string', default: 'main' }),
        argv => {
          callBaseTag({
            root,
            name: String(argv.name),
            branch: String(argv.branch),
            ...(argv.commit ? { commit: String(argv.commit) } : {}),
          })
        },
      )
      .demandCommand(1, 'which base verb?'),
  )
  .command(
    'wake [name]',
    'Scaffold a new Seed project',
    yargs =>
      yargs.positional('name', {
        type: 'string',
        description:
          'Project name (a new directory); omit for current directory',
      }),
    async argv => {
      await callWake({
        root,
        name: argv.name,
      })
    },
  )
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
    'Check if packages are installed correctly (--audit for the security scan)',
    yargs =>
      yargs
        .option('audit', {
          type: 'boolean',
          description:
            'Security scan: audit dependencies against the advisory database',
        })
        .option('code', {
          type: 'boolean',
          description:
            'Also run the static code scan (dangerous native imports, taint) over the project',
        })
        .option('sarif', {
          type: 'string',
          description:
            'Write a SARIF 2.1.0 report to this path (for GitHub code scanning)',
        })
        .option('format', {
          type: 'string',
          choices: ['human', 'json', 'sarif'],
          description: 'Console output format (default human)',
        })
        .option('fix', {
          type: 'boolean',
          description:
            'Rewrite deck.tree to the safe dependency versions',
        }),
    async argv => {
      await callSeek({
        root,
        audit: argv.audit,
        code: argv.code,
        sarif: argv.sarif,
        format: argv.format as 'human' | 'json' | 'sarif' | undefined,
        fix: argv.fix,
      })
    },
  )
  .command(
    'host',
    'Publish package to registry',
    yargs =>
      yargs
        .option('dry', {
          type: 'boolean',
          description: 'Dry run (no upload)',
        })
        .option('registry', {
          type: 'string',
          description: 'Registry host to publish to',
        }),
    async argv => {
      await callHost({
        root,
        dryRun: argv.dry,
        registry: argv.registry,
      })
    },
  )
  .command(
    'make',
    'Build/compile the project',
    yargs =>
      yargs
        .option('ride', {
          type: 'boolean',
          alias: 'watch',
          description:
            'Watch files and recompile incrementally on every change',
        })
        .option('separate', {
          type: 'boolean',
          description:
            'Separate compilation: per-module artifacts, dependents check against interfaces (early cutoff)',
        })
        .option('trees', {
          type: 'boolean',
          description:
            'Compile .tree files even when package.json owns `make` (which otherwise runs that script instead)',
        }),
    async argv => {
      await callMake({
        root,
        ride: argv.ride,
        separate: argv.separate,
        trees: argv.trees,
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
    'Run benchmarks, or profile a file with --cpu / --memory',
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
        .option('cpu', {
          type: 'string',
          description: 'Profile CPU hotspots of a .tree file',
        })
        .option('memory', {
          type: 'string',
          description: 'Profile memory use of a .tree file',
        })
        .option('top', {
          type: 'number',
          description: 'Show the top-N hottest functions (with --cpu)',
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
        cpu: argv.cpu,
        memory: argv.memory,
        top: argv.top,
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
      // arguments for a command-line program: everything after a literal
      // `--` passes through untouched (`term boot cli.tree -- code save
      // development`), and bare extra positionals work for the simple
      // cases (`term boot cli.tree show`)
      const marker = process.argv.indexOf('--')
      const args =
        marker >= 0
          ? process.argv.slice(marker + 1)
          : (argv._ as (string | number)[])
              .slice(1)
              .map(String)
              .filter(a => a !== argv.entry)

      await callBoot({
        root,
        entry: argv.entry,
        port: argv.port,
        env: argv.env as never,
        remote: argv.remote,
        remoteToken: argv['remote-token'],
        args,
      })
    },
  )
  .command(
    'cast [entry]',
    'Build an SSR app into a deployable Cloudflare Worker (work/index.ts + build/)',
    yargs =>
      yargs
        .positional('entry', {
          type: 'string',
          description:
            'Entry .tree module (defaults to deck.tree boot)',
        })
        .option('target', {
          type: 'string',
          description: 'Deploy target (cloudflare)',
          default: 'cloudflare',
        }),
    async argv => {
      await callCast({
        root,
        entry: argv.entry,
        target: argv.target,
      })
    },
  )
  .command(
    'halt',
    'Stop running term boot servers (all, or specific --port list)',
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
    'feed [entry]',
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
      await callFeed({
        root,
        entry: argv.entry,
        port: argv.port,
        env: argv.env as never,
      })
    },
  )
  .command(
    'work',
    'Run the long-lived compiler worker (shared warm analyzer)',
    yargs =>
      yargs
        .option('port', {
          alias: 'p',
          type: 'number',
          description: 'Port to serve on',
        })
        .option('env', { type: 'string', description: 'Target env' }),
    async argv => {
      await callWork({
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
          description: 'What to move (code)',
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
    'roll [kind]',
    'The roll of this project: every deck, exception, task, route and tell in the build',
    yargs =>
      yargs
        .positional('kind', {
          type: 'string',
          description: 'One kind of entry, in full: deck, exception, task, dock, tell, kind, or a kind a deck declares with `roll <name>` (default: every deck with counts)',
        })
        .option('json', { type: 'boolean', description: 'Output the roll as JSON' })
        .option('private', {
          type: 'boolean',
          description: 'Only the exceptions no tell covers',
        })
        .option('host', {
          type: 'string',
          description: 'Only the entries of one deck (@term/site)',
        })
        .option('path', {
          type: 'boolean',
          description: 'Under each exception, one call path from every task that can raise it to the raise site',
        }),
    async argv => {
      await callRoll({
        root,
        kind: argv.kind,
        json: argv.json,
        private: argv.private,
        path: argv.path,
        host: argv.host,
      })
    },
  )
  .command(
    'mold [file]',
    'Shape Term data: a data file (long or compact) or JSON, printed as long form, compact (--pack) or JSON (--json)',
    yargs =>
      yargs
        .positional('file', {
          type: 'string',
          description: 'A data .tree file, a .line stream, or a .json file (stdin when absent)',
        })
        .option('pack', { type: 'boolean', description: 'Compact form, one entry per line' })
        .option('json', { type: 'boolean', description: 'JSON, keys in snake case' })
        .option('keep', { type: 'boolean', description: 'With --json: leave keys as written' })
        .option('tree', { type: 'boolean', description: 'The input is JSON' })
        .option('trees', { type: 'boolean', description: 'Keep tree anchors instead of expanding them' })
        .option('lines', { type: 'boolean', description: 'The input is a compact stream: one form per line, anchors re-declarable' })
        .option('check', { type: 'boolean', description: 'Only report problems, exit 1 on any' }),
    async argv => {
      await callMold({
        root,
        file: argv.file,
        pack: argv.pack,
        json: argv.json,
        keep: argv.keep,
        tree: argv.tree,
        trees: argv.trees,
        lines: argv.lines,
        check: argv.check,
      })
    },
  )
  .command(
    'view [path]',
    'Check a document in the view role and print what it uses',
    yargs =>
      yargs
        .positional('path', {
          type: 'string',
          description: 'A .tree document, or a directory of them (the project root when absent)',
        })
        .option('find', { type: 'boolean', description: 'Print the query manifest instead' }),
    async argv => {
      await callView({
        root,
        path: argv.path,
        find: argv.find,
        back: argv.back as string | undefined,
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
          description: 'Fuzz inputs per term',
        })
        // `seeds`, not `terms`: these are fuzzing seeds, unrelated to the language's
        // name. `compiler-audit.ts` and the CLI dispatch test both use `--seeds`.
        .option('seeds', {
          type: 'number',
          description: 'Distinct fuzz seeds',
        })
        .option('fuzz-timeout', {
          type: 'number',
          description: 'Watchdog seconds per fuzz term',
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
        description: 'What to show (code, deck, self)',
      }),
    async argv => {
      if (argv.what === 'code') {
        const { loadManifest, showCode } =
          await import('@cluesurf/deck.tree')

        try {
          const manifest = await loadManifest({ dir: root })
          console.log(showCode(manifest.code))
        } catch {
          logFail('No deck.tree found')
        }
      } else {
        showInfo(readVersion())
      }
    },
  )
  .command(
    'zone [rest..]',
    'Secrets and environment: run a command with a zone\'s values, and manage them',
    yargs =>
      yargs
        .positional('rest', {
          type: 'string',
          array: true,
          description: 'The zone verb and its arguments',
        })
        // Everything after `zone` belongs to the zone console, including
        // flags this parser would otherwise claim, and the `--` that
        // separates a zone path from the command to run.
        .parserConfiguration({ 'unknown-options-as-args': true })
        // `--help` belongs to the zone console too, so this parser must not
        // claim it and print its own one-line summary instead.
        .help(false)
        .strict(false),
    async () => {
      await callZone({ root, argv: process.argv })
    },
  )
  .completion(
    'fill',
    'Print the shell completion script (add to your shell rc file)',
  )
  .demandCommand(0)
  .strict(false)
  .fail((msg, err) => {
    // a thrown command error exits with the general failure code; a usage / validation error exits with the
    // conventional usage code (64), so scripts can tell a bad invocation from a real failure.
    if (err) {
      logFail(err.message)
      process.exit(1)
    }

    if (msg) {
      logFail(msg)
    }

    process.exit(64)
  })
  .version('version', 'Show the version number', readVersion())
  .alias('version', 'v')

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
          `term ${suggestion}`,
        )}?`,
      )
    } else {
      logFail(
        `Unknown command "${cmd}". Run "term" for a list of commands.`,
      )
    }

    process.exit(64)
  }
}

main().catch(err => {
  logFail(err.message ?? String(err))
  process.exit(1)
})
