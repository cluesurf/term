import chalk from 'chalk'
import os from 'os'

export function showBanner(): void {
  console.log('')
  console.log(
    chalk.green.bold('  seed') + chalk.gray(' - the Seed toolkit'),
  )
  console.log('')
  console.log(chalk.white('  Usage: seed <verb> [objects] [options]'))
  console.log('')
  console.log(chalk.yellow('  Package Management'))
  console.log('    seed load              Install all dependencies')
  console.log('    seed save <deck>       Add a dependency')
  console.log('    seed toss <deck>       Remove a dependency')
  console.log('    seed link              Link local package for dev')
  console.log('    seed seek              Check if decks are installed')
  console.log('    seed host              Publish to registry')
  console.log('')
  console.log(chalk.yellow('  Start'))
  console.log('    seed wake <name>       Scaffold a new project')
  console.log('')
  console.log(chalk.yellow('  Build and Run'))
  console.log('    seed make              Build the project')
  console.log('    seed make --ride       Watch and rebuild')
  console.log('    seed boot              Start the app')
  console.log('    seed feed              Dev server (hot reload)')
  console.log('    seed work              Background compiler worker')
  console.log('    seed test              Run tests')
  console.log('    seed time              Benchmark (or --cpu/--memory profile)')
  console.log('    seed walk              Start REPL')
  console.log('    seed wash              Clean build artifacts')
  console.log('')
  console.log(chalk.yellow('  Version'))
  console.log('    seed move mark         Bump patch version')
  console.log('    seed move mark 2       Bump minor version')
  console.log('    seed move mark 1       Bump major version')
  console.log('')
  console.log(chalk.yellow('  Info'))
  console.log('    seed show              Show seed info')
  console.log('    seed show deck tree    Show dependency tree')
  console.log('    seed note              Show package info')
  console.log('    seed fill              Print shell completion script')
  console.log('    seed --version         Show the version number')
  console.log('')
  console.log(
    chalk.gray('  Run seed <verb> --hint for command-specific help'),
  )
  console.log('')
}

export function showInfo(version = '0.0.0'): void {
  console.log('')
  console.log(chalk.green.bold('seed') + ' ' + chalk.gray(version))
  console.log('')
  console.log(
    chalk.white('  Platform:  ') + os.platform() + ' ' + os.arch(),
  )
  console.log(chalk.white('  Node:      ') + process.version)
  console.log(chalk.white('  Home:      ') + os.homedir())
  console.log('')
}
