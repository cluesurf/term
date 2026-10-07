import os from 'node:os'
import path from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { bannerText } from '@term/make/code/show'
import { callShow, termVersion } from '@term/call/code/show'
import { callLoad } from '@term/call/code/load'
import { callSave } from '@term/call/code/save'
import { callZone } from '@term/call/code/zone'
import { callToss } from '@term/call/code/toss'
import { callHost } from '@term/call/code/host'
import { callBind } from '@term/call/code/bind'
import {
  callSelfBack,
  callSelfCheck,
  callSelfFind,
  callSelfList,
  callSelfLoad,
  callSelfNeed,
  callSelfPick,
  callSelfShow,
  callSelfToss,
  callSelfUpdate,
  callSelfWash,
} from '@term/call/code/self'
import { callSelfSkill } from '@term/call/code/skill'
import { callSeek } from '@term/call/code/seek'
import { callLink, callUnlink } from '@term/call/code/link'
import { callMake } from '@term/call/code/make'
import { callScan } from '@term/call/code/scan'
import { callMind } from '@term/call/code/mind'
import { callTest } from '@term/call/code/test'
import { callTime } from '@term/call/code/time'
import { callMark } from '@term/call/code/mark'
import { bootMode, callBoot } from '@term/call/code/boot'
import { callCast } from '@term/call/code/cast'
import { callHalt } from '@term/call/code/halt'
import { refuseFeed } from '@term/call/code/feed'
import { callWork } from '@term/call/code/work'
import { callWake } from '@term/call/code/wake'
import { callWash } from '@term/call/code/wash'
import { callWalk } from '@term/call/code/walk'
import { callMove } from '@term/call/code/move'
import { callNote } from '@term/call/code/note'
import { callForm } from '@term/call/code/form'
import { callLint } from '@term/call/code/lint'
import { callHold } from '@term/call/code/hold'
import {
  callHunt,
  HUNT_FUZZ_CHILD,
  runHuntFuzzChild,
} from '@term/call/code/hunt'
import { callLook } from '@term/call/code/look'
import { callRoll } from '@term/call/code/roll'
import { callMold } from '@term/call/code/mold'
import { callView } from '@term/call/code/view'
import { closeRun, failRun, openRun, printData, report, setOutput } from '@term/call/code/output'
import type { OutputFlags } from '@term/call/code/output'
import { settle } from '@term/call/code/home'
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
  'bind',
  'self',
  'update',
  'make',
  'scan',
  'mind',
  'test',
  'time',
  'mark',
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

// `term hunt` forks this same CLI to run each fuzz campaign under a watchdog. Handled before yargs so the hidden
// verb never appears in help or in the did-you-mean list.
if (process.argv[2] === HUNT_FUZZ_CHILD) {
  runHuntFuzzChild(process.argv.slice(3))
}

const cli = yargs(hideBin(process.argv))
  .scriptName('term')
  .usage('Usage: term <verb> [objects] [options]')
  // `--hint`, `-h` and `--help` are yargs' own help. `hint` was declared as a plain flag that nothing read, so
  // `term wash -h` washed and every other `term <verb> -h` ran the verb (guides: commands/wash, 2026-10-04)
  .help('hint', 'Show help')
  .alias('hint', ['h', 'help'])
  .option('back', {
    alias: 'b',
    type: 'string',
    choices: ['json', 'link', 'line'] as const,
    default: 'line',
    description: 'Response format',
  })
  // the global output flags of the terminal output standard (note/term/output/standard.md, sections 18 and 20), on
  // every command, read once by the middleware below into the run every command prints through (code/output.ts)
  .option('quiet', { alias: 'q', type: 'boolean', description: 'Print only failed items and the closing item' })
  .option('verbose', { type: 'boolean', description: 'Also print debug items' })
  .option('trace', { type: 'boolean', description: 'Also print trace items, for debugging Term itself' })
  .option('log', { type: 'string', choices: ['json'] as const, description: 'One JSON object per event on stdout, and no human view' })
  .option('color', { type: 'string', choices: ['auto', 'always', 'never'] as const, default: 'auto', description: 'Color the output' })
  .option('utc', { type: 'boolean', description: 'Clocks in UTC rather than local time' })
  .option('plain', { type: 'boolean', description: 'One sentence per item, for screen readers and transcripts' })
  .option('strict', { type: 'boolean', description: 'Warnings fail the run with exit 1' })
  .option('motion', { type: 'boolean', default: true, description: 'Animate the spinner (--no-motion holds it still)' })
  .option('yes', { alias: 'y', type: 'boolean', description: 'Accept every default instead of asking' })
  .option('raw', { type: 'boolean', description: "Pass a child process's output through untouched" })
  .option('source', { type: 'string', description: 'Show one service of a stream, without tags' })
  .option('all', { type: 'boolean', description: 'Show every problem and list entry past the cap' })
  .middleware(argv => setOutput(argv as OutputFlags, termVersion()))
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
    'Scaffold a new Term project',
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
        // `--like`, "install a subset", was accepted and read by nothing, and nothing said what a subset was. It is
        // gone rather than given a meaning nobody asked for (guides: packages/install, 2026-10-04)
        .option('offline', {
          type: 'boolean',
          description: 'Install without network',
        }),
    async argv => {
      await callLoad({
        root,
        clean: argv.clean,
        offline: argv.offline,
      })
    },
  )
  .command(
    'save [deck] [mark]',
    'Add a dependency',
    yargs =>
      yargs
        .positional('deck', {
          type: 'string',
          description: 'Package name to add',
        })
        .positional('mark', {
          type: 'string',
          description: 'The versions it accepts: 1.4.2, 1.x.x, ^1.2.0, ~1.2.0, 1.0.0..2.0.0 (default 0.x.x)',
        }),
    async argv => {
      await callSave({
        root,
        deck: argv.deck,
        constraint: argv.mark,
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
      yargs
        .positional('deck', {
          type: 'string',
          description: 'Path to local package',
        })
        .option('toss', {
          type: 'boolean',
          description: 'Remove the deck\'s link instead, so the next term load installs the published one',
        }),
    async argv => {
      // `--toss` reaches `callUnlink`, which existed and no verb called (guides: packages/install, 2026-10-04)
      if (argv.toss) {
        await callUnlink({ root, deck: argv.deck ?? '' })

        return
      }

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
          description: 'The oci:// registry to publish to, in place of the scope default',
        })
        .option('trust', {
          type: 'string',
          description: 'Add this public key to the scope key set instead of publishing',
        })
        .option('untrust', {
          type: 'string',
          description: 'Remove this public key from the scope key set instead of publishing',
        })
        .option('ping', {
          type: 'boolean',
          description: 'Announce the already-published version to the package index instead of publishing',
        }),
    async argv => {
      await callHost({
        root,
        dryRun: argv.dry,
        registry: argv.registry,
        trust: argv.trust,
        untrust: argv.untrust,
        ping: argv.ping,
      })
    },
  )
  .command(
    'bind',
    'Log in to term.surf with Google, for publishing',
    yargs =>
      yargs.option('toss', {
        type: 'boolean',
        description: 'Forget the term.surf token on this machine instead',
      })
      .option('again', {
        type: 'boolean',
        description: 'Log in again even while the saved token works',
      }),
    async argv => {
      await callBind({ root, toss: argv.toss, again: argv.again })
    },
  )
  .command('self', 'The versions of term on this machine: list, find, load, pick, need, show, toss, wash, check, update, back, and skill, which teaches a coding agent its verbs', yargs =>
    yargs
      .command('list', 'Installed versions, the front, the default, and what runs here', {}, async () => {
        await callSelfList({ root })
      })
      .command(
        'find [range]',
        'Released versions, newest first',
        yargs =>
          yargs
            .positional('range', { type: 'string', description: 'Only versions in this range: 2.6.x' })
            .option('all', { type: 'boolean', description: 'Every platform, not only this one' }),
        async argv => {
          await callSelfFind({ root, range: argv.range, all: argv.all })
        },
      )
      .command(
        'load <range>',
        'Install a version, verified, without switching to it',
        yargs => yargs.positional('range', { type: 'string', demandOption: true, description: 'A version or a range: 2.6.4, 2.6.x' }),
        async argv => {
          await callSelfLoad({ root, range: argv.range })
        },
      )
      .command(
        'pick <range>',
        'The version that runs outside any project',
        yargs => yargs.positional('range', { type: 'string', demandOption: true, description: 'A version or a range: 2.6.4, 2.6.x' }),
        async argv => {
          await callSelfPick({ root, range: argv.range })
        },
      )
      .command(
        'need [range]',
        "The version this project needs, written to deck.tree and pinned in lock.tree",
        yargs =>
          yargs
            .positional('range', { type: 'string', description: 'A version or a range: 2.6.4, 2.6.x' })
            .option('none', { type: 'boolean', description: 'Remove the project\'s request instead' }),
        async argv => {
          await callSelfNeed({ root, range: argv.range, none: argv.none })
        },
      )
      .command('show', 'Which version runs here, and every rule that decided it', {}, async () => {
        await callSelfShow({ root, flag: process.env['TERM_NEED_FLAG'] })
      })
      .command(
        'toss <mark>',
        'Remove one installed version',
        // `mark`, not `version`: yargs keeps `--version` for itself, and a positional of that name reads as its flag
        yargs => yargs.positional('mark', { type: 'string', demandOption: true, description: 'The exact version: 2.6.2' }),
        async argv => {
          await callSelfToss({ root, mark: argv.mark })
        },
      )
      .command(
        'wash',
        'Versions nothing has used in --days; removed only with --commit',
        yargs =>
          yargs
            .option('days', { type: 'number', description: 'Unused for this many days (default 90)' })
            .option('commit', { type: 'boolean', description: 'Remove them, rather than list them' }),
        async argv => {
          await callSelfWash({ root, days: argv.days, commit: argv.commit })
        },
      )
      .command('check', 'Verify this install against the signed release', {}, async () => {
        await callSelfCheck({ root })
      })
      .command('update', 'Install the newest release and move the front to it', {}, async () => {
        await callSelfUpdate({ root })
      })
      .command('back', 'Move the front back to the previous version', {}, async () => {
        await callSelfBack({ root })
      })
      .command('skill', "Write the skill that teaches a coding agent term's verbs into this project, at .claude/skills/term/SKILL.md", {}, argv => {
        callSelfSkill({ root, version: termVersion(), back: argv.back as string | undefined })
      })
      .demandCommand(1, 'which self verb?'),
  )
  // `term update` is `term self update`, the one self verb typed often enough to want a short name. need-run.ts sends it
  // to the front as it does `self`, so a project pinned to an older release cannot answer it with that release's update
  .command('update', 'Install the newest release and move the front to it (term self update)', {}, async () => {
    await callSelfUpdate({ root })
  })
  .command(
    'make [file]',
    'Build/compile the project, or with --emit one program for one backend',
    yargs =>
      yargs
        .positional('file', {
          type: 'string',
          description: 'With --emit: the program to emit, with its whole import closure',
        })
        .option('emit', {
          type: 'string',
          description:
            'Write ONE program as a single source file for node (TypeScript), rust, swift or kotlin (runtime prelude plus emitted code), or for wgsl or hvm (a numeric part of the language: anything outside it is refused, by name and place), or llvm (IR) or wasm (WASI), through the Rust. A check error refuses',
        })
        .option('out', {
          type: 'string',
          description: 'With --emit: the file to write (default standard output)',
        })
        .option('units', {
          type: 'boolean',
          description:
            'With --emit rust, swift or kotlin and --out <folder>: one file per Term module beside a shared one, each written only when it changed',
        })
        .option('env', {
          type: 'string',
          description:
            'Every program of the project (a file with a `run`, `boot` or `main` task taking nothing) for rust, swift, kotlin or node, one file each under host/<env>/. One that does not build is reported and the rest written',
        })
        .option('build', {
          type: 'boolean',
          description:
            'With --emit: add the main that calls the program and build it with its toolchain, into --out <folder> (default host/<target>). With --env: build every program, beside its source',
        })
        .option('run', {
          type: 'boolean',
          description: 'With --emit: build it, then run it, its output and exit code passed through',
        })
        .option('main', {
          type: 'string',
          description: 'With --build or --run: the task the program starts at (default run, else boot, else main)',
        })
        .option('ride', {
          type: 'boolean',
          alias: 'watch',
          description:
            'Watch files and recompile incrementally on every change',
        })
        .option('separate', {
          type: 'boolean',
          description:
            'Separate compilation, the default: each module checked once against its imports\' stubs and cached, per-module artifacts',
        })
        .option('merged', {
          type: 'boolean',
          description:
            'One whole-program compile per file instead, optimized across modules (the build before separate compilation)',
        })
        .option('explain', {
          type: 'boolean',
          description:
            'Say why each unit that was built was built: its own text, a name it reaches, its settings, or the compiler',
        })
        .option('trees', {
          type: 'boolean',
          description:
            'Compile .tree files even when package.json owns `make` (which otherwise runs that script instead)',
        })
        .option('target', {
          type: 'string',
          description:
            'Build a native app cask for a platform (macos, ios, android, linux, windows), a Compose app (compose: the desktop with its JVM, compose-android: an APK), or an iPhone app drawn by UIKit (uikit: an Xcode project, signed ad hoc with --team)',
        })
        .option('team', {
          type: 'string',
          description: 'With --target uikit: the Apple team to sign for (read from the keychain when it holds one team)',
        })
        .option('link', {
          type: 'string',
          description: 'With --target uikit: the https address the app will be served at, for an install page an iPhone opens',
        })
        .option('page', {
          type: 'string',
          description: 'The page entry of the cask app (default face/base.tree)',
        })
        .option('entry', {
          type: 'string',
          description: 'The cask entry of the app (default cask.tree; for a Compose or UIKit target, the file the boot line of deck.tree names, else app.tree)',
        })
        .option('url', {
          type: 'string',
          description: 'Dev loop: the cask loads this URL instead of the bundled page',
        })
        .option('sign', {
          type: 'string',
          description: 'A Developer ID identity for codesign (ad hoc when absent)',
        })
        .option('dmg', {
          type: 'boolean',
          description: 'Also make a .dmg beside the .app',
        })
        .option('publish', {
          type: 'string',
          description: 'Also publish the page just built as a signed over-the-air update into this directory',
        })
        .option('channel', {
          type: 'string',
          description: 'The update channel --publish writes (default main)',
        }),
    async argv => {
      if (argv.emit !== undefined) {
        const { callEmit } = await import('@term/call/code/emit')

        callEmit({
          root,
          file: argv.file,
          target: argv.emit,
          out: argv.out,
          units: argv.units,
          build: argv.build,
          run: argv.run,
          main: argv.main,
        })

        return
      }

      // every program of the project for one backend (call/code/make-native.ts)
      if (argv.env !== undefined) {
        const { callMakeNative } = await import('@term/call/code/make-native')

        callMakeNative({ root, env: argv.env, build: argv.build })

        return
      }

      // a Compose app (compose-target-0004): its views drawn by Compose, no WebView, packaged for the desktop with its
      // own JVM or as an APK
      if (argv.target === 'compose' || argv.target === 'compose-android') {
        const { makeCompose } = await import('@term/call/code/compose')

        await makeCompose({ root, target: argv.target, entry: argv.entry })

        return
      }

      // an iPhone app drawn by UIKit, no WebView (swiftui-target-0004): an Xcode project, archived for a device, and
      // signed ad hoc into an .ipa when there is a team to sign for
      if (argv.target === 'uikit') {
        const { makeUikit } = await import('@term/call/code/uikit')

        await makeUikit({ root, entry: argv.entry, team: argv.team, link: argv.link })

        return
      }

      if (argv.target) {
        const { makeCask } = await import('@term/call/code/cask')

        await makeCask({
          root,
          target: argv.target as never,
          page: argv.page,
          entry: argv.entry,
          url: argv.url,
          sign: argv.sign,
          dmg: argv.dmg,
          publish: argv.publish,
          channel: argv.channel,
        })

        return
      }

      // a file is built alone only with `--emit`. Named without it, it was ignored and the whole project built, with
      // nothing said about the argument (guides: commands/make, 2026-10-04)
      if (argv.file !== undefined) {
        openRun({ verb: 'make', root, facts: [argv.file] })
        report({ glyph: 'failed', kind: 'problem', subject: `term make builds the whole project, and ${argv.file} is one file` })

        process.exitCode = closeRun({ verdict: 'Nothing built', next: `term make --emit <backend> ${argv.file}, or term make`, failure: 'usage' })

        return
      }

      await callMake({
        root,
        ride: argv.ride,
        merged: argv.merged,
        trees: argv.trees,
        explain: argv.explain,
      })
    },
  )
  .command(
    'scan <file>',
    'Type-check a file and report diagnostics (the verifier)',
    yargs =>
      yargs
        .positional('file', {
          type: 'string',
          description: 'The .tree file to check',
          demandOption: true,
        })
        .option('fix', {
          type: 'boolean',
          description: 'Write the sure fixes into the file and scan again. A guess is offered, never written',
        }),
    async argv => {
      await callScan({
        root,
        file: argv.file,
        back: argv.back,
        fix: argv.fix,
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
        })
        .option('forget', {
          type: 'string',
          description: 'Forget the fact with this name',
        }),
    async argv => {
      await callMind({
        root,
        fact: argv.fact,
        name: argv.name,
        kind: argv.kind,
        find: argv.find,
        forget: argv.forget,
        back: argv.back,
      })
    },
  )
  .command(
    'test [filter]',
    'Run tests',
    yargs =>
      yargs
        .positional('filter', {
          type: 'string',
          description: 'Filter tests',
        })
        .option('merged', {
          type: 'boolean',
          description: 'Compile each test file whole, instead of one unit at a time with the units shared across files',
        })
        .option('case', {
          type: 'string',
          description: 'Run only the tests whose phrase or name holds this, in any case',
        })
        .option('env', {
          type: 'string',
          description: 'The backend the tests run on: node (the default), rust, swift or kotlin',
        })
        .option('ride', {
          type: 'boolean',
          description: 'Run, then run again on every edit the tests whose files the edit reaches, until ctrl-c',
        })
        .option('update', {
          type: 'boolean',
          description: 'Write what each `want snapshot` sees into the test file\'s snapshot file, instead of comparing against it',
        }),
    async argv => {
      await callTest({
        root,
        filter: argv.filter,
        merged: argv.merged,
        case: argv.case,
        env: argv.env,
        ride: argv.ride,
        update: argv.update,
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
    'mark [rest..]',
    'Compare emitted code with hand-written code per target (time: time-* tasks)',
    yargs =>
      yargs
        .positional('rest', {
          type: 'string',
          array: true,
          description:
            'a filter on <family>/<program>, or `list`; then --target, --runs, --quick, --check, --size, --export, --markdown, --purpose, --label',
        })
        // every flag after `mark` belongs to the runner, `--help` included
        .parserConfiguration({ 'unknown-options-as-args': true })
        .help(false)
        .strict(false),
    async () => {
      await callMark({ root, argv: process.argv })
    },
  )
  .command(
    'boot [mode] [entry]',
    'Compile and run an app, in development (the default) or production',
    yargs =>
      yargs
        .positional('mode', {
          type: 'string',
          description: 'moon, dev or development (the default), or star, prod or production',
        })
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
        })
        .option('out', {
          type: 'string',
          description:
            'Write a command-line program to this directory (run.mjs, app.mjs, dock.mjs) instead of running it',
        }),
    async argv => {
      // arguments for a command-line program: everything after a literal
      // `--` passes through untouched (`term boot cli.tree -- code save
      // development`), and bare extra positionals work for the simple
      // cases (`term boot cli.tree show`)
      const marker = process.argv.indexOf('--')
      // a first word that names no mode is the entry (`term boot cli.tree show`), and callBoot reads the two so
      const { mode, entry } = bootMode(argv.mode, argv.entry)
      const args =
        marker >= 0
          ? process.argv.slice(marker + 1)
          : (argv._ as (string | number)[])
              .slice(1)
              .map(String)
              // the entry and a mode word are the command's own, and every other word the program's
              .filter(a => a !== entry && !(mode !== undefined && a === argv.mode))

      await callBoot({
        root,
        mode,
        entry,
        port: argv.port,
        env: argv.env as never,
        remote: argv.remote,
        remoteToken: argv['remote-token'],
        args,
        out: argv.out,
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
    'Retired: the development server is term boot',
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
      refuseFeed({ root })
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
        .option('env', { type: 'string', description: 'Target env' })
        .option('target', {
          type: 'string',
          description:
            'Develop a native app: a cask (its page on a dev server with hot swaps, the app pointed at it), or `compose` / `compose-android` (rebuilt and relaunched on each edit, on the screen it was on)',
        })
        .option('page', { type: 'string', description: 'The page entry of the cask app (default face/base.tree)' })
        .option('entry', { type: 'string', description: 'The entry of the app (default cask.tree; for a Compose or UIKit target, the file the boot line of deck.tree names, else app.tree)' }),
    async argv => {
      // a Compose app (live-reload): no WebView to swap a page in, so each edit is a new build, relaunched where it was
      if (argv.target === 'compose' || argv.target === 'compose-android') {
        const { workCompose } = await import('@term/call/code/compose-work')

        await workCompose({ root, target: argv.target, entry: argv.entry })

        return
      }

      if (argv.target) {
        const { workCask } = await import('@term/call/code/cask')

        await workCask({
          root,
          target: argv.target as never,
          page: argv.page,
          entry: argv.entry,
          port: argv.port,
        })

        return
      }

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
        description: 'What to clean: deck, the build output (the default); tail, the logs; boot, what boot and cast write; base, the machine-wide module cache',
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
          description: 'What to move (mark, the version; code is the old spelling)',
        })
        .positional('level', {
          type: 'string',
          description: 'Bump level: 1=major, 2=minor, 3=patch, or a word (rc, beta) for a pre-release',
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
    'Inspect what a module offers (forms + tasks): its own and what it passes on with bear',
    yargs =>
      yargs
        .positional('target', {
          type: 'string',
          description:
            'A package path (@term/bind/code/browser/dom) or a .tree file',
        })
        .option('json', { type: 'boolean', description: 'Output JSON' })
        .option('csv', { type: 'boolean', description: 'Output CSV' })
        .option('kind', {
          type: 'string',
          choices: ['form', 'task'] as const,
          description: 'Only forms or only tasks',
        })
        .option('all', { type: 'boolean', description: 'Everything the module loads, not only what it offers' }),
    async argv => {
      await callLook({
        root,
        target: argv.target,
        json: argv.json,
        csv: argv.csv,
        kind: argv.kind,
        all: argv.all,
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
        })
        .option('diff', {
          type: 'string',
          description:
            'What changed in what each task can reach and raise since a roll file (term roll --json > before.json) or a git ref. A task that gained a native module is a warning, so --strict makes it a gate',
        }),
    async argv => {
      await callRoll({
        root,
        kind: argv.kind,
        // `--back json` too, the spelling every agent-facing verb takes
        json: argv.json || argv.back === 'json',
        private: argv.private,
        path: argv.path,
        host: argv.host,
        diff: argv.diff,
      })
    },
  )
  .command(
    'mold [file]',
    'Shape Term data: a data file (long or compact), JSON or tree/code, printed as long form, compact (--pack), JSON (--json) or tree/code (--code)',
    yargs =>
      yargs
        .positional('file', {
          type: 'string',
          // a `.line` name is a compact file like any other: a stream is told by `--lines`, never by its name
          description: 'A data file, long or compact (.tree or .line), a stream with --lines, or a .json file (stdin when absent)',
        })
        .option('pack', { type: 'boolean', description: 'Compact form, one entry per line' })
        .option('json', { type: 'boolean', description: 'JSON, keys in snake case' })
        .option('keep', { type: 'boolean', description: 'With --json: leave keys as written' })
        .option('tree', { type: 'boolean', description: 'The input is JSON' })
        .option('trees', { type: 'boolean', description: 'Keep tree anchors instead of expanding them' })
        .option('lines', { type: 'boolean', description: 'The input is a compact stream: one form per line, anchors re-declarable' })
        .option('check', { type: 'boolean', description: 'Only report problems, exit 1 on any' })
        .option('code', { type: 'boolean', description: 'tree/code bytes, Zstandard frames where smaller (to a file or a pipe)' })
        .option('canonical', { type: 'boolean', description: 'With --code: the canonical bytes, every frame uncompressed' }),
    async argv => {
      await callMold({
        code: argv.code,
        canonical: argv.canonical,
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
    'The proof gate: every file compiles, no claim is open, every tier-0 obligation is proven or baselined. One line, non-zero exit',
    yargs =>
      yargs
        .positional('paths', {
          type: 'string',
          description:
            'Files or directories to verify (default: current directory)',
        })
        .option('cross', {
          type: 'boolean',
          default: false,
          description: 'Also run the cross-backend differential',
        })
        .option('commit', {
          type: 'boolean',
          description:
            'Rewrite hold.json to the obligations not proven today, and print how many that added',
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
        commit: argv.commit,
      })
    },
  )
  .command(
    'hunt [glob]',
    'Automated bug-hunt: oracles + fuzzing over .tree files (crashes, hangs, round-trip, determinism, backend emit, perf). Fails when any check did not run',
    yargs =>
      yargs
        .positional('glob', {
          type: 'string',
          description:
            "Directory of .tree files to hunt (default: this project's .tree files, as term make finds them)",
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
        .option('budget', {
          type: 'number',
          description: 'Milliseconds one compile may take before it is a finding (default 1000)',
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
        budget: argv.budget,
        json: argv.json,
      })
    },
  )
  .command(
    'show [what] [name]',
    'Display information',
    yargs =>
      yargs
        .positional('what', {
          type: 'string',
          description:
            '`mark` for this package\'s version (`code` is the old spelling), `tools` for the native toolchains, `kink` for what a diagnostic means, `name` for one name of the project with what surrounds it; omit for the toolchain version and platform',
        })
        .positional('name', {
          type: 'string',
          description: 'With `kink`: a diagnostic\'s name or code (type-mismatch, 0007, L019), every one when left out. With `name`: the task, form or mask to show',
        })
        .option('budget', {
          type: 'number',
          description: 'With `name`: the most tokens the answer may take, roughly four characters each (default 4000)',
        }),
    async argv => {
      await callShow({ root, what: argv.what, name: argv.name, budget: argv.budget, back: argv.back, version: termVersion() })
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
    // a thrown command error ends the run through failRun (exit 1, or 70 for a bug in Term); a usage or validation
    // error is wrong command-line usage, exit 2 (section 18), so scripts can tell a bad invocation from a real failure
    if (err) {
      process.exit(failRun(err, root))
    }

    process.exit(usageFailure(msg || 'The command line was not understood.'))
  })
  .version('version', 'Show the version number', termVersion())
  .alias('version', 'v')

async function main(): Promise<void> {
  // `.base/@cluesurf/term` to `.base/@term/code`, once, before any verb reads a path (home.ts `settle`). Every path
  // home.ts builds settles itself, and these two are for the verbs ported to Term, which read work/home.tree's
  // constant and cannot: the user's folder and the working directory's
  settle(path.join(os.homedir(), '.base'))
  settle(path.join(root, '.base'), root)

  const argv = await cli.parse()

  if (argv._.length === 0) {
    // `term` alone answers with the list of commands: data on stdout
    printData(bannerText())

    return
  }

  const cmd = String(argv._[0])

  if (!COMMANDS.includes(cmd)) {
    const suggestion = suggestCommand(cmd)

    process.exit(usageFailure(`There is no command named ${cmd}`, suggestion ? `term ${suggestion}` : 'term, for the list of commands'))
  }
}

// wrong command-line usage (section 18): a ✗ item saying what was not understood, a `next` field with what to run,
// exit 2
function usageFailure(message: string, next = 'term --hint'): number {
  // yargs refuses before the middleware runs, so the version is set here for the opening item. The flags were not
  // understood, so the run prints as the defaults say
  setOutput({}, termVersion())
  openRun({ verb: 'term', root })
  // yargs writes some refusals over several lines: the first is the subject, the rest message lines
  const [first = message, ...rest] = message.split('\n').map(line => line.trim()).filter(line => line !== '')
  report({ glyph: 'failed', kind: 'problem', verb: 'term', subject: first.charAt(0).toUpperCase() + first.slice(1), message: rest })

  return closeRun({ verdict: 'The command line was not understood', next, failure: 'usage' })
}

main().catch(err => {
  process.exit(failRun(err, root))
})
