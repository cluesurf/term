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
export function bannerText(): string {
  return `${[
    '',
    chalk.green.bold('  term') + chalk.gray(' - the Term toolkit'),
    '',
    chalk.white('  Usage: term <verb> [objects] [options]'),
    '',
    chalk.yellow('  Package Management'),
    '    term load              Install all dependencies',
    '    term save <deck>       Add a dependency',
    '    term toss <deck>       Remove a dependency',
    '    term link              Link local package for dev',
    '    term seek              Check if decks are installed',
    '    term host              Publish to registry',
    '    term bind              Log in to term.surf, for publishing',
    '',
    chalk.yellow('  Start'),
    '    term wake <name>       Scaffold a new project',
    '',
    chalk.yellow('  Build and Run'),
    '    term make              Build the project',
    '    term make --ride       Watch and rebuild',
    '    term boot              Start the app',
    '    term feed              Dev server (hot reload)',
    '    term work              Background compiler worker',
    '    term test              Run tests',
    '    term time              Benchmark (or --cpu/--memory profile)',
    '    term walk              Start REPL',
    '    term wash              Clean build artifacts',
    '',
    chalk.yellow('  Version'),
    '    term move mark         Bump patch version',
    '    term move mark 2       Bump minor version',
    '    term move mark 1       Bump major version',
    '',
    chalk.yellow('  Info'),
    '    term show              Show the toolchain version and platform',
    "    term show mark         Show this package's version",
    '    term note              Show package info',
    '    term fill              Print shell completion script',
    '    term --version         Show the version number',
    '',
    // `--help`, not `--hint`: `term wake --hint` runs wake (scaffolding the current directory) instead of
    // printing its help, so the banner must not send anyone there
    chalk.gray('  Run term <verb> --help for command-specific help'),
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
