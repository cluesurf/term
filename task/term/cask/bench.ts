// The cask measuring harness: build the bench app into a macOS cask and measure what note/project/term/app/07-boot-and-size.md
// budgets, so nothing is optimised before it is measured. Item cask-0015.
//
//   pnpm term:cask-bench              build, measure, print the table
//   pnpm term:cask-bench --commit     also write note/project/term/cask/bench.md with the date
//   pnpm term:cask-bench --runs 20    more runs (default 10, after 3 warmups)
//
// Five numbers, and how each is taken:
//   binary size          the executable inside the .app, in bytes
//   javascript shipped   the page bundle, in bytes
//   cold start to exit   process start to exit for a page that leaves through the bridge the moment it runs. The
//                        path is the executable, the window, the WebView, the page, one bridge message, the native
//                        exit. Tauri's own bench measures the same span
//   time to first paint  process start to the `ready` line the cask prints when the page has finished loading
//   max memory           the process's maximum resident set, from /usr/bin/time -l
//
// Timed here with a one-second pause between runs, because back-to-back runs drift upward on macOS. When hyperfine is
// installed its statistics are printed too. No window is shown. Runs from the Term root. Writes only under
// tmp/cask/, and the baseline note only on --commit. Design: note/project/term/cask/readme.md.
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { assembleBundle, buildPage, buildProgram, signBundle } from '@term/call/code/cask'
import { generateBridge } from '@term/call/code/cask-generate'
import { TERM_ROOT, parentRoot } from '../root'

const TERM = TERM_ROOT
const CASK = join(TERM, 'deck/cask')
const OUT = join(TERM, 'tmp/cask')
const APP = join(CASK, 'test/bench')
const NOTE = (): string => join(parentRoot(), 'note/project/term/cask/bench.md')

const APP_NAME = 'TermBench'
const APP_IDENTIFIER = 'surf.term.bench'

const WARMUPS = 3
const DEFAULT_RUNS = 10
// the pause between runs, in milliseconds. Back-to-back launches drift upward on macOS
const PAUSE = 1000

const argv = process.argv.slice(2)
const commit = argv.includes('--commit')
const runs = argv.includes('--runs') ? Number(argv[argv.indexOf('--runs') + 1]) : DEFAULT_RUNS

function say(text: string): void {
  console.log(`bench  ${text}`)
}

function fail(text: string): never {
  console.error(`bench  ${text}`)
  console.log('cask/bench: 0 pass, 1 fail')
  process.exit(1)
}

function pause(ms: number): Promise<void> {
  return new Promise(done => setTimeout(done, ms))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

const format = (ms: number): string => `${ms.toFixed(1)} ms`

// one run: process start to the `ready` line, and process start to exit
function once(exe: string): Promise<{ ready: number; exit: number }> {
  return new Promise((resolve, reject) => {
    const start = performance.now()
    let ready = 0
    const child = spawn(exe, [], { stdio: ['ignore', 'pipe', 'inherit'] })
    child.stdout.on('data', (chunk: Buffer) => {
      if (ready === 0 && chunk.toString().includes('ready')) {
        ready = performance.now() - start
      }
    })
    child.on('error', reject)
    child.on('exit', code => {
      const exit = performance.now() - start

      if (code !== 0) {
        reject(new Error(`the bench app exited ${code}`))

        return
      }

      resolve({ ready, exit })
    })
  })
}

// the maximum resident set of one run, in bytes, read from /usr/bin/time -l
function memory(exe: string): number {
  const ran = spawnSync('/usr/bin/time', ['-l', exe], { encoding: 'utf8' })
  const found = /(\d+)\s+maximum resident set size/.exec(ran.stderr)

  return found ? Number(found[1]) : 0
}

function hyperfine(exe: string): string | undefined {
  if (spawnSync('which', ['hyperfine'], { encoding: 'utf8' }).status !== 0) {
    return undefined
  }

  const ran = spawnSync(
    'hyperfine',
    ['--warmup', String(WARMUPS), '--runs', String(runs), '--prepare', 'sleep 1', '--export-markdown', '-', exe],
    { encoding: 'utf8' },
  )

  return ran.status === 0 ? ran.stdout : undefined
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true })
  const bundle = assembleBundle({ out: OUT, name: APP_NAME, identifier: APP_IDENTIFIER, version: '0.0.2' })
  const pageDir = join(bundle.resources, 'webview')
  const work = join(OUT, 'work-bench')

  generateBridge({ page: join(APP, 'page.tree'), out: APP, commit: false })
  await buildPage({ root: TERM, page: join(APP, 'page.tree'), entry: `import { boot } from './app'\nboot()\n`, into: pageDir, title: 'Term bench', work: join(work, 'page') })
  buildProgram({ root: CASK, entry: join(APP, 'main.tree'), driver: `boot(${JSON.stringify(pageDir)})`, exe: bundle.exe, work })
  signBundle({ app: bundle.app })
  say(`assembled ${bundle.app}`)

  const binary = statSync(bundle.exe).size
  const javascript = statSync(join(pageDir, 'app.js')).size

  for (let i = 0; i < WARMUPS; i += 1) {
    await once(bundle.exe)
    await pause(PAUSE)
  }

  const readies: number[] = []
  const exits: number[] = []

  for (let i = 0; i < runs; i += 1) {
    const { ready, exit } = await once(bundle.exe)
    readies.push(ready)
    exits.push(exit)
    await pause(PAUSE)
  }

  const rss = memory(bundle.exe)
  const stats = hyperfine(bundle.exe)
  const date = new Date().toISOString().slice(0, 10)

  const table = [
    `| metric | value | budget |`,
    `| --- | --- | --- |`,
    `| binary size | ${(binary / 1024).toFixed(0)} KB | under 2 MB |`,
    `| javascript shipped | ${javascript} bytes | under 10 KB interactive |`,
    `| cold start to exit, median of ${runs} | ${format(median(exits))} | under 200 ms to interactive |`,
    `| time to first paint, median of ${runs} | ${format(median(readies))} | under 120 ms |`,
    `| max memory | ${(rss / (1024 * 1024)).toFixed(1)} MB | under 60 MB |`,
  ]

  console.log(table.join('\n'))

  if (stats) {
    console.log(stats)
  }

  const note = [
    '# Cask bench',
    '',
    `Taken by \`pnpm term:cask-bench\` (task/term/cask/bench.ts) on ${date}, on this laptop, macOS, an unsigned`,
    `\`.app\` built with \`swiftc -O\`. ${WARMUPS} warmups, ${runs} runs, a one-second pause between runs. The budget`,
    'column is note/project/term/app/07-boot-and-size.md.',
    '',
    ...table,
    '',
    ...(stats ? ['hyperfine:', '', stats, ''] : []),
    'The bench app is deck/cask/test/bench: a page that exits through the bridge the moment it runs, so cold start',
    'to exit spans the executable, the window, the WebView, the page, one bridge message and the native exit. Time',
    'to first paint is process start to the `ready` line the cask prints from `on-ready`.',
    '',
  ].join('\n')

  if (commit) {
    writeFileSync(NOTE(), note)
    say(`wrote ${NOTE()}`)
  } else {
    say('pass --commit to write the baseline to note/project/term/cask/bench.md')
  }

  console.log('cask/bench: 1 pass, 0 fail')
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
