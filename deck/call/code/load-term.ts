// The installer behind `curl -fsSL https://term.surf/load | sh`, built to `load.mjs` and served beside the script
// (note/term/plan/term-load-install.md, note/term/output/standard.md).
//
// The shell script (load.ps1 on Windows) only checks for Node and runs this. Everything else is the CLI's own code, bundled:
//
//   1  the version: TERM_LOAD_VERSION, or the newest release
//   2  installed through need-load.ts, the ONE install path `term self load`, `self update` and dispatch take: the
//      release index, the signature over the layer, the signer in the `@term` key set, the download's sha256, an
//      unpack beside any other version, files shared with one already installed
//   3  the front, bin/term, linked to it only after all of that
//   4  bin on PATH for every new shell: one marked line in the shell's profile, never twice (`putOnPath`).
//      TERM_LOAD_PATH=0 leaves every profile alone
//
// IT PRINTS THROUGH THE ONE OUTPUT LIBRARY, as one `load` run, so an install looks like every other term command.
// It used to be a 200-line shell script that re-implemented the registry calls and then ran `term self check` as a
// child, whose own run landed in the middle of the script's unformatted lines.
//
// TERM_LOAD_REGISTRY=<http(s)://host> reads releases from another registry (the end-to-end test's loopback one).

import { execFileSync } from 'child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'fs'
import { homedir } from 'os'
import nodePath from 'path'

import { userHome } from '@term/call/code/home'
import { linkFront, loadVersion } from '@term/call/code/need-load'
import { closeRun, field, location, openRun, printData, report, setOutput, showPath } from '@term/call/code/output'
import { releases, reportLoaded } from '@term/call/code/self'

const VERSION = /^\d+\.\d+\.\d+$/

// The marker over every line this writes to a profile. Declared ABOVE `await main()`: main runs at this line, and a
// constant below it is read before it is set (the minified bundle makes it a `var`, so it reads `undefined`)
const MARK = '# term (https://term.surf/load)'

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

  const bin = nodePath.join(home, 'bin')

  report({
    glyph: 'changed',
    kind: 'change',
    verb: 'link',
    subject: `bin/term to ${version}`,
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
        : { glyph: 'skipped', verb: 'path', subject: one.shown, facts: ['already there'] },
    )
  }

  // THIS shell's PATH is its own, and no installer can change it: the line for it is data, on stdout (section 18)
  if (!onPath) {
    printData(
      windows
        ? `$env:Path = "${bin};" + $env:Path\n`
        : `export PATH="${bin}:$PATH"\n`,
    )
  }

  closeRun({
    verdict: `term ${version} is installed`,
    done: true,
    ...(onPath
      ? { next: 'term --help' }
      : {
          message: [
            automatic
              ? 'New terminals find term. For this one, run the line above, or open a new one.'
              : windows
                ? 'TERM_LOAD_PATH=0, so PATH was not changed: add bin to your user PATH, and run the line above for this terminal.'
                : "TERM_LOAD_PATH=0, so no profile was edited: add the line above to your shell's profile.",
          ],
        }),
  })
}

type Profile = { form: 'added' | 'there'; shown: string; line: string }

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

  if (text.includes(input.bin) || text.includes('.base/@cluesurf/term/bin')) {
    return { form: 'there', shown, line: input.line }
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
  const there = current.split(';').some(entry => entry.replace(/\\+$/, '').toLowerCase() === bin.toLowerCase())

  if (there) {
    return { form: 'there', shown, line: bin }
  }

  const next = current ? `${bin};${current}` : bin

  execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable("Path", $env:TERM_NEXT_PATH, "User")`], {
    env: { ...process.env, TERM_NEXT_PATH: next },
  })

  return { form: 'added', shown, line: bin }
}
