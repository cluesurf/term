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
//
// IT PRINTS THROUGH THE ONE OUTPUT LIBRARY, as one `load` run, so an install looks like every other term command.
// It used to be a 200-line shell script that re-implemented the registry calls and then ran `term self check` as a
// child, whose own run landed in the middle of the script's unformatted lines.
//
// TERM_LOAD_REGISTRY=<http(s)://host> reads releases from another registry (the end-to-end test's loopback one).

import nodePath from 'path'

import { userHome } from '@term/call/code/home'
import { linkFront, loadVersion } from '@term/call/code/need-load'
import { closeRun, location, openRun, printData, report, setOutput, showPath } from '@term/call/code/output'
import { releases, reportLoaded } from '@term/call/code/self'

const VERSION = /^\d+\.\d+\.\d+$/

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

  if (!onPath) {
    // the line itself is data the person copies: on stdout, as it is, never wrapped (section 18)
    printData(
      windows
        ? `[Environment]::SetEnvironmentVariable('Path', "${bin};" + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')\n`
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
            windows
              ? 'bin is not on PATH: run the line above in PowerShell, then open a new terminal. Nothing was changed for you.'
              : "bin/term is not on PATH: add the line above to your shell's profile (~/.zshrc, ~/.bashrc). No profile was edited.",
          ],
        }),
  })
}
