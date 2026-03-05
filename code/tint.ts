import chalk from 'chalk'

export function good(text: string): string {
  return chalk.green(text)
}

export function warn(text: string): string {
  return chalk.yellow(text)
}

export function fail(text: string): string {
  return chalk.red(text)
}

export function fade(text: string): string {
  return chalk.gray(text)
}

export function bold(text: string): string {
  return chalk.bold(text)
}

export function name(text: string): string {
  return chalk.cyan(text)
}

export function mark(text: string): string {
  return chalk.magenta(text)
}

export function logGood(text: string): void {
  console.log(chalk.green('  ✓ ') + text)
}

export function logWarn(text: string): void {
  console.log(chalk.yellow('  ⚠ ') + text)
}

export function logFail(text: string): void {
  console.error(chalk.red('  ✗ ') + text)
}

export function logStep(text: string): void {
  console.log(chalk.blue('  → ') + text)
}

export function logHead(text: string): void {
  console.log('')
  console.log(chalk.bold(text))
}

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  return String(err)
}
