import chalk from 'chalk'
import os from 'os'

// The banner `term` prints with no verb, and the line `term show` prints. Both said `seed` (the language's old name)
// until 2026-10-02, and the banner listed `term move mark` and `term show deck tree`, neither of which the CLI
// accepts: `move` takes `code`, and `show` takes `code` or nothing.
export function showBanner(): void {
  console.log('')
  console.log(
    chalk.green.bold('  term') + chalk.gray(' - the Term toolkit'),
  )
  console.log('')
  console.log(chalk.white('  Usage: term <verb> [objects] [options]'))
  console.log('')
  console.log(chalk.yellow('  Package Management'))
  console.log('    term load              Install all dependencies')
  console.log('    term save <deck>       Add a dependency')
  console.log('    term toss <deck>       Remove a dependency')
  console.log('    term link              Link local package for dev')
  console.log('    term seek              Check if decks are installed')
  console.log('    term host              Publish to registry')
  console.log('')
  console.log(chalk.yellow('  Start'))
  console.log('    term wake <name>       Scaffold a new project')
  console.log('')
  console.log(chalk.yellow('  Build and Run'))
  console.log('    term make              Build the project')
  console.log('    term make --ride       Watch and rebuild')
  console.log('    term boot              Start the app')
  console.log('    term feed              Dev server (hot reload)')
  console.log('    term work              Background compiler worker')
  console.log('    term test              Run tests')
  console.log('    term time              Benchmark (or --cpu/--memory profile)')
  console.log('    term walk              Start REPL')
  console.log('    term wash              Clean build artifacts')
  console.log('')
  console.log(chalk.yellow('  Version'))
  console.log('    term move code         Bump patch version (to the next even patch)')
  console.log('    term move code 2       Bump minor version')
  console.log('    term move code 1       Bump major version')
  console.log('')
  console.log(chalk.yellow('  Info'))
  console.log('    term show              Show the toolchain version and platform')
  console.log('    term show code         Show this package\'s version')
  console.log('    term note              Show package info')
  console.log('    term fill              Print shell completion script')
  console.log('    term --version         Show the version number')
  console.log('')
  console.log(
    // `--help`, not `--hint`: `term wake --hint` runs wake (scaffolding the current directory) instead of
    // printing its help, so the banner must not send anyone there
    chalk.gray('  Run term <verb> --help for command-specific help'),
  )
  console.log('')
}

export function showInfo(version = '0.0.0'): void {
  console.log('')
  console.log(chalk.green.bold('term') + ' ' + chalk.gray(version))
  console.log('')
  console.log(
    chalk.white('  Platform:  ') + os.platform() + ' ' + os.arch(),
  )
  console.log(chalk.white('  Node:      ') + process.version)
  console.log(chalk.white('  Home:      ') + os.homedir())
  console.log('')
}
