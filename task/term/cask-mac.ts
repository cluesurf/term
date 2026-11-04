// Build the blog into a macOS cask and launch it, or let it write a PNG of its own page and quit. The same build
// `term make --target macos` runs from the blog app's directory, driven from here so the proof of cask-0003 is one
// command.
//
//   pnpm term:cask-mac            build the blog app and launch it in front
//   pnpm term:cask-mac --shot     build, let the spike app write tmp/cask/TermBlog-macos.png from behind every other
//                                 window, and quit. The proof of cask-0003
//
// Runs from the Term root, the way every other term task does. Writes only under tmp/cask/ and the blog app's
// own host/ directory. Design: note/project/term/cask/readme.md.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assembleBundle, buildPage, buildProgram, makeCask, signBundle } from '@term/call/code/cask'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const CASK = join(TERM, 'deck/cask')
const OUT = join(TERM, 'tmp/cask')
const BLOG = join(TERM, 'deck/site/test/site')

const shot = process.argv.includes('--shot')

async function main(): Promise<void> {
  if (!shot) {
    const { app } = await makeCask({ root: BLOG, target: 'macos' })
    console.log(`cask  launching ${app}. Close the window to end`)
    execFileSync(join(app, 'Contents/MacOS/Blog'), [], { stdio: 'inherit' })

    return
  }

  // the proof: the spike app (deck/cask/test/app/main.tree) shows the blog page behind every other window, writes
  // a PNG of it through `snapshot` once `on-ready` fires, and quits. Taken by the WebView itself, so it does not
  // matter which display the window landed on or what was in front of it
  mkdirSync(OUT, { recursive: true })
  const bundle = assembleBundle({ out: OUT, name: 'TermBlog', identifier: 'surf.term.blog', version: '0.0.2' })
  const pageDir = join(bundle.resources, 'webview')
  const shotFile = join(OUT, 'TermBlog-macos.png')

  await buildPage({
    root: TERM,
    page: join(BLOG, 'face/base.tree'),
    entry: `import { boot } from './app'\nboot()\n`,
    into: pageDir,
    title: 'Term blog',
    work: join(OUT, 'page'),
  })
  buildProgram({
    root: CASK,
    entry: join(CASK, 'test/app/main.tree'),
    driver: `boot(${JSON.stringify(pageDir)}, true, ${JSON.stringify(shotFile)})`,
    exe: bundle.exe,
    work: join(OUT, 'work'),
  })
  signBundle({ app: bundle.app })
  rmSync(shotFile, { force: true })
  execFileSync(bundle.exe, [], { stdio: 'inherit' })

  if (!existsSync(shotFile)) {
    console.error(`cask  the app quit without writing ${shotFile}`)
    process.exit(1)
  }

  console.log(`cask  screenshot ${shotFile}`)
}

main().catch(error => {
  console.error(`cask  ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
