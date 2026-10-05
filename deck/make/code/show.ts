import chalk from 'chalk'
import os from 'os'

// The banner `term` prints with no verb, and the line `term show` prints. Both said `seed` (the language's old name)
// until 2026-10-02, and the banner listed `term show deck tree`, which the CLI does not accept. `move` and `show`
// take `mark`, the manifest's version field, since the version became `mark <1.4.2>` and `code` came to name the
// code root folder (note/term/plan/manifest-mark-and-code-root.md). `code` is still taken as the old spelling.
//
// Each is TEXT first (`bannerText`, `infoText`): it is the answer the person asked for, so the CLI writes it as data
// on stdout through the terminal output library (call/code/output.ts, `printData`). The text is byte for byte what
// the `console.log` lines wrote, a newline after every line.
// The banner's commands, by section: the command as typed, then what it does. Data, so the description column is
// computed rather than padded by hand: a hand-padded `term save <deck> [mark]` was one cell too long for its column and
// pushed its description out of line with every other
const BANNER_SECTIONS: { title: string; commands: [string, string][] }[] = [
  {
    title: 'Package Management',
    commands: [
      ['term load', 'Install all dependencies'],
      ['term save <deck> [mark]', 'Add a dependency'],
      ['term toss <deck>', 'Remove a dependency'],
      ['term link', 'Link local package for dev (--toss to unlink)'],
      ['term seek', 'Check if decks are installed'],
      ['term host', 'Publish to registry'],
      ['term bind', 'Log in to term.surf, for publishing'],
    ],
  },
  { title: 'Start', commands: [['term wake <name>', 'Scaffold a new project']] },
  {
    title: 'Build and Run',
    commands: [
      ['term make', 'Build the project'],
      ['term make --ride', 'Watch and rebuild'],
      ['term boot', 'Start the app'],
      ['term feed', 'Dev server (hot reload)'],
      ['term work', 'Background compiler worker'],
      ['term test', 'Run tests'],
      ['term time', 'Benchmark (or --cpu/--memory profile)'],
      ['term walk', 'Start REPL'],
      ['term wash', 'Clean build artifacts'],
      ['term cast', 'Build the Cloudflare Worker'],
      ['term halt', 'Stop a running boot'],
    ],
  },
  {
    title: 'Check and Prove',
    commands: [
      ['term hold', 'Every file compiles and every obligation holds'],
      ['term scan <file>', 'Type-check one file'],
      ['term lint', 'Find and fix style problems'],
      ['term form', 'Format files in place'],
      ['term look <module>', 'List what a module offers'],
      ['term roll', "The build's decks, exceptions, tasks and routes"],
      ['term view [path]', 'Check a document and print what it uses'],
      ['term mold [file]', 'Convert data files'],
      ['term hunt', 'Fuzz the compiler on this project'],
      ['term mark', 'Measure Term against hand-written code'],
      ['term mind', "The project's memory"],
    ],
  },
  {
    title: 'Systems',
    commands: [
      ['term base', 'The base record system'],
      ['term zone', 'Secrets and environment'],
    ],
  },
  {
    title: 'Version',
    commands: [
      ['term move mark', 'Bump patch version'],
      ['term move mark 2', 'Bump minor version'],
      ['term move mark 1', 'Bump major version'],
      ['term move mark rc', 'Start or move a pre-release'],
      ['term self', 'This install of term: check, update, or go back'],
      ['term update', 'Install the newest term (term self update)'],
    ],
  },
  {
    title: 'Info',
    commands: [
      ['term show', 'Show the toolchain version and platform'],
      ['term show mark', "Show this package's version"],
      ['term show tools', 'Show each native toolchain and its version'],
      ['term note', 'Show package info'],
      ['term fill', 'Print shell completion script'],
      ['term --version', 'Show the version number'],
    ],
  },
]

// the fewest spaces between a command and its description
const BANNER_GAP = 2

export function bannerText(): string {
  // one column for every section, so the descriptions line up down the whole banner
  const width = Math.max(...BANNER_SECTIONS.flatMap(section => section.commands.map(([command]) => command.length))) + BANNER_GAP
  const sections = BANNER_SECTIONS.flatMap(section => [
    chalk.magentaBright(`  ${section.title}`),
    ...section.commands.map(([command, description]) => `    ${command.padEnd(width)}${description}`),
    '',
  ])

  return `${[
    '',
    chalk.green.bold('  term') + chalk.gray(' - the Term toolkit'),
    '',
    chalk.white('  Usage: term <verb> [objects] [options]'),
    '',
    ...sections,
    // `-h`, `--hint` and `--help` are one help since 2026-10-04 (`term wake --hint` used to run wake)
    chalk.gray('  Run term <verb> -h for command-specific help'),
    '',
  ].join('\n')}\n`
}

export function infoText(version = '0.0.0'): string {
  // no blank line before or after, so a paste into a bug report carries the block and nothing else
  return `${[
    chalk.green.bold('term') + ' ' + chalk.gray(version),
    '',
    chalk.white('  Platform:  ') + os.platform() + ' ' + os.arch(),
    chalk.white('  Node:      ') + process.version,
    chalk.white('  Home:      ') + os.homedir(),
  ].join('\n')}\n`
}

export function showBanner(): void {
  process.stdout.write(bannerText())
}

export function showInfo(version = '0.0.0'): void {
  process.stdout.write(infoText(version))
}
