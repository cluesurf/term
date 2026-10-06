// The installer behind `curl -fsSL https://term.surf/load | sh`, built to `load.mjs` and served beside the script
// (note/term/plan/term-load-install.md, note/term/output/standard.md).
//
// The shell script (load.ps1 on Windows) only checks for Node and runs this. Everything else is the CLI's own code, bundled:
//
//   1  the version: TERM_LOAD_VERSION, or the newest release
//   2  installed through need-load.ts, the ONE install path `term self load`, `self update` and dispatch take: the
//      release index, the signature over the layer, the signer in the `@term` key set, the download's sha256, an
//      unpack beside any other version, files shared with one already installed
//   3  the front, call/term, linked to it only after all of that
//   4  call/ on PATH for every new shell: one marked line in the shell's profile, never twice (`putOnPath`).
//      TERM_LOAD_PATH=0 leaves every profile alone
//
// IT PRINTS THROUGH THE ONE OUTPUT LIBRARY, as one `load` run, so an install looks like every other term command.
// It used to be a 200-line shell script that re-implemented the registry calls and then ran `term self check` as a
// child, whose own run landed in the middle of the script's unformatted lines.
//
// TERM_LOAD_REGISTRY=<http(s)://host> reads releases from another registry (the end-to-end test's loopback one).

import { execFileSync } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import nodePath from 'path'

import { FRONT, HOME_POSIX, frontDir, userHome } from '@term/call/code/home'
import { linkFront, loadVersion } from '@term/call/code/need-load'
import { closeRun, field, location, openRun, printData, report, setOutput, showPath } from '@term/call/code/output'
import { releases, reportLoaded } from '@term/call/code/self'

const VERSION = /^\d+\.\d+\.\d+$/

// The marker over every line this writes to a profile. Declared ABOVE `await main()`: main runs at this line, and a
// constant below it is read before it is set (the minified bundle makes it a `var`, so it reads `undefined`)
const MARK = '# term (https://term.surf/load)'

// the front's folder as a profile line names it, under `$HOME` or spelled out. Above `await main()` for MARK's reason:
// below it, both read `undefined` in the bundle, and the profile edit failed on `PREVIOUS_FRONTS.filter` (2026-10-05)
const FRONT_POSIX = `${HOME_POSIX}/${FRONT}`

// its old names: `bin/` under the folder before it moved, and `bin/` under the moved folder before the front was
// renamed `call/` (home.ts). Both still reach the front through the links the renames left, and are rewritten here so
// the profile names the folder that exists
const PREVIOUS_FRONTS = ['.base/@cluesurf/term/bin', `${HOME_POSIX}/bin`]

await main()

async function main(): Promise<void> {
  const registry = process.env['TERM_LOAD_REGISTRY']?.trim()

  // the loader's registry is a URL; the release route takes `oci://host/namespace`
  if (registry && !process.env['TERM_RELEASE_REGISTRY']) {
    process.env['TERM_RELEASE_REGISTRY'] = `oci://${new URL(registry).host}/cluesurf/term`
  }

  const home = userHome()

  setOutput({}, '')
  openRun({ verb: 'load', root: home, subject: showPath(home), tool: 'term.surf/load' })

  const asked = process.env['TERM_LOAD_VERSION']?.trim()

  if (asked && !VERSION.test(asked)) {
    report({ glyph: 'failed', kind: 'problem', verb: 'load', subject: `TERM_LOAD_VERSION=${asked} is not a version: write 2.6.8` })
    closeRun({ verdict: 'Nothing was installed', failure: 'usage' })

    return
  }

  const version = asked ?? (await releases())?.[0]

  if (!version) {
    closeRun({ verdict: 'Nothing was installed', failure: 'environment' })

    return
  }

  const loaded = await loadVersion({ version })

  if (!reportLoaded(loaded)) {
    closeRun({ verdict: 'Nothing was installed', failure: 'environment' })

    return
  }

  linkFront(version)

  // the front's folder, the one put on PATH: `call/` (home.ts `frontDir`)
  const bin = frontDir(home)

  report({
    glyph: 'changed',
    kind: 'change',
    verb: 'link',
    subject: `${nodePath.basename(bin)}/term to ${version}`,
    fields: [location(showPath(nodePath.join(bin, process.platform === 'win32' ? 'term.cmd' : 'term')))],
  })

  const windows = process.platform === 'win32'
  const onPath = (process.env['PATH'] ?? '')
    .split(nodePath.delimiter)
    .some(entry => (windows ? entry.replace(/\\+$/, '').toLowerCase() === bin.toLowerCase() : entry === bin))
  const automatic = process.env['TERM_LOAD_PATH']?.trim() !== '0'
  const profiles = automatic ? putOnPath(bin) : []

  for (const one of profiles) {
    report(
      one.form === 'added'
        ? { glyph: 'added', kind: 'change', verb: 'path', subject: one.shown, fields: [field('line', one.line)] }
        : one.form === 'moved'
          ? { glyph: 'changed', kind: 'change', verb: 'path', subject: one.shown, facts: [`now ${FRONT_POSIX}`] }
          : { glyph: 'skipped', verb: 'path', subject: one.shown, facts: ['already there'] },
    )
  }

  for (const other of otherTerms(bin)) {
    report({
      glyph: 'warning',
      verb: 'path',
      subject: `another term is on PATH, ${other.version}`,
      message: ['A terminal runs whichever term comes first on its PATH. Remove the other to have one.'],
      fields: [location(showPath(other.file)), ...(other.remove ? [field('next', other.remove)] : [])],
    })
  }

  // THIS shell's PATH is its own, and a child cannot change it. The line that does is data, on stdout (section 18),
  // so `eval "$(curl -fsSL https://term.surf/load | sh)"` runs it in the shell that asked: PATH, and `hash -r`, which
  // makes bash and zsh forget where they last found `term`. Everything else this prints is on stderr, so stdout
  // holds that line and nothing else
  const captured = !process.stdout.isTTY

  if (!onPath && !windows) {
    printData(refreshLine(bin))
  }

  closeRun({
    verdict: `term ${version} is installed`,
    done: true,
    ...(onPath
      ? { next: 'term --help' }
      : {
          message: [
            !automatic
              ? windows
                ? 'TERM_LOAD_PATH=0, so the user Path was not changed: add bin to it.'
                : "TERM_LOAD_PATH=0, so no profile was edited: add the line above to your shell's profile."
              : windows
                ? 'This terminal and new ones find term.'
                : captured
                  ? 'New terminals find term, and so does this one once it runs the line on standard output.'
                  : 'New terminals find term. For this one, run the line above, or install with eval "$(curl -fsSL https://term.surf/load | sh)", which does both.',
          ],
        }),
  })
}

// The line that puts bin first on THIS shell's PATH, in its own syntax
function refreshLine(bin: string): string {
  if (nodePath.basename(process.env['SHELL'] ?? '') === 'fish') {
    return `set -gx PATH ${bin} $PATH\n`
  }

  return `export PATH="${bin}:$PATH"; hash -r 2>/dev/null || true\n`
}

type OtherTerm = { file: string; version: string; remove?: string }

// Every other `term` on PATH, with its version and how to remove it: an npm or pnpm global from before term had an
// installer of its own is the one this finds (2.5.22, `@cluesurf/term`), and a person typing `term` there gets it
function otherTerms(bin: string): OtherTerm[] {
  const name = process.platform === 'win32' ? 'term.cmd' : 'term'
  const found: OtherTerm[] = []
  const seen = new Set<string>()

  const real = realOf(bin)

  for (const dir of (process.env['PATH'] ?? '').split(nodePath.delimiter)) {
    const file = nodePath.join(dir, name)

    // this install's own bin under another name is not another term: `.base/@cluesurf/term/bin` is a link to it since
    // the folder moved (home.ts), and a terminal opened before the move still has it on PATH
    if (!dir || dir === bin || realOf(dir) === real || seen.has(file) || !existsSync(file)) {
      continue
    }

    seen.add(file)

    let version = 'version unknown'

    try {
      version = execFileSync(file, ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || version
    } catch {
      // a `term` that is not this one at all: named by its path alone
    }

    const remove = /[\\/]pnpm[\\/]/.test(file) ? 'pnpm remove -g @cluesurf/term' : /[\\/](npm|node_modules)[\\/]|[\\/]lib[\\/]node/.test(file) ? 'npm uninstall -g @cluesurf/term' : undefined

    found.push({ file, version, ...(remove ? { remove } : {}) })
  }

  return found
}

// a folder with its links resolved, or the folder as written when it does not exist
function realOf(dir: string): string {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

// `moved`: a profile that named the front's folder by an old name, rewritten to the new one in place
type Profile = { form: 'added' | 'there' | 'moved'; shown: string; line: string }

/**
 * Put bin on PATH for every NEW shell, the way rustup, bun and deno do: one marked line in the profile of the shell
 * the person logs in with, written once. A profile that already names bin, by this or by hand, is left as it is.
 *
 *   zsh    $ZDOTDIR/.zshrc, else ~/.zshrc
 *   bash   ~/.bashrc, and ~/.bash_profile on macOS, where Terminal opens login shells that read only that
 *   fish   ~/.config/fish/conf.d/term.fish, a file of its own, as fish reads that folder
 *   other  ~/.profile, which every POSIX login shell reads
 *   Windows  the user's Path, through PowerShell: `setx` cuts a value at 1,024 characters
 *
 * TERM_LOAD_PATH=0 turns it off, for a person who keeps their dotfiles by hand.
 */
function putOnPath(bin: string): Profile[] {
  const home = homedir()

  if (process.platform === 'win32') {
    return [windowsPath(bin)]
  }

  // `$HOME/...` rather than the expanded path, so a synced profile works on another machine
  const portable = bin.startsWith(`${home}/`) ? `$HOME/${bin.slice(home.length + 1)}` : bin
  const shell = nodePath.basename(process.env['SHELL'] ?? '')
  const zdot = process.env['ZDOTDIR']?.trim() || home

  if (shell === 'fish') {
    const line = `contains ${portable} $PATH; or set -gx PATH ${portable} $PATH`

    return [writeProfile({ file: nodePath.join(home, '.config', 'fish', 'conf.d', 'term.fish'), line, bin, home })]
  }

  const line = `export PATH="${portable}:$PATH"`
  const files =
    shell === 'zsh'
      ? [nodePath.join(zdot, '.zshrc')]
      : shell === 'bash'
        ? [nodePath.join(home, '.bashrc'), ...(process.platform === 'darwin' ? [nodePath.join(home, '.bash_profile')] : [])]
        : [nodePath.join(home, '.profile')]

  return files.map(file => writeProfile({ file, line, bin, home }))
}

// one profile: the marked line appended, unless the file names bin already
function writeProfile(input: { file: string; line: string; bin: string; home: string }): Profile {
  const shown = input.file.startsWith(`${input.home}/`) ? `~/${input.file.slice(input.home.length + 1)}` : input.file
  let text = ''

  try {
    text = readFileSync(input.file, 'utf8')
  } catch {
    // a profile that does not exist yet is made
  }

  // the line this writes says `$HOME/...`, and a person may have spelled the path out: either is there already
  if (text.includes(input.bin) || text.includes(FRONT_POSIX)) {
    return { form: 'there', shown, line: input.line }
  }

  // the line an earlier install wrote, for an old name: renamed where it stands, nothing else in the file touched, so
  // the profile keeps one line and it names the folder that exists
  const previous = PREVIOUS_FRONTS.filter(name => text.includes(name))

  if (previous.length > 0) {
    writeFileSync(input.file, previous.reduce((written, name) => written.split(name).join(FRONT_POSIX), text))

    return { form: 'moved', shown, line: input.line }
  }

  mkdirSync(nodePath.dirname(input.file), { recursive: true })
  appendFileSync(input.file, `${text === '' || text.endsWith('\n') ? '' : '\n'}\n${MARK}\n${input.line}\n`)

  return { form: 'added', shown, line: input.line }
}

// the user's Path on Windows, read and written through PowerShell so nothing else in it is touched
function windowsPath(bin: string): Profile {
  const shown = 'the user Path'
  const read = '[Environment]::GetEnvironmentVariable("Path", "User")'
  const current = execFileSync('powershell.exe', ['-NoProfile', '-Command', read], { encoding: 'utf8' }).trim()
  const entries = current.split(';')
  const named = (entry: string, folder: string) => entry.replace(/\\+$/, '').toLowerCase() === folder.toLowerCase()

  if (entries.some(entry => named(entry, bin))) {
    return { form: 'there', shown, line: bin }
  }

  // the entry an earlier install made for an old name, renamed where it stands (home.ts)
  const previous = [nodePath.join(homedir(), '.base', '@cluesurf', 'term', 'bin'), nodePath.join(homedir(), '.base', '@term', 'code', 'bin')]
  const isPrevious = (entry: string) => previous.some(folder => named(entry, folder))
  const moved = entries.some(isPrevious)
  const next = moved ? entries.map(entry => (isPrevious(entry) ? bin : entry)).join(';') : current ? `${bin};${current}` : bin

  execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable("Path", $env:TERM_NEXT_PATH, "User")`], {
    env: { ...process.env, TERM_NEXT_PATH: next },
  })

  return { form: moved ? 'moved' : 'added', shown, line: bin }
}
