// beat-term as it ships (beat-term spec.md 3.4, D013): `term make --target uikit` from deck/tool/tool/beat-term, then
// xcodebuild for the simulator, so the drive and the build test hold the same app. Unsigned (`team: ''`), Release,
// derived data in <app>/host/uikit/derived-simulator. It builds and never installs
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeUikit, uikitIdentity } from '@term/call/code/uikit'

// the app folder: deck/tool/tool/beat-term
export const BEAT_TERM_ROOT = join(import.meta.dirname, '../../../../../../../deck/tool/tool/beat-term')

// xcodebuild's `error:` lines only, at most 30
function errorLines(output: string): string {
  return output
    .split('\n')
    .filter(line => /error:/.test(line))
    .slice(0, 30)
    .join('\n')
}

// the same project built for `destination` into `derived`, answering the `.app` it wrote
export function xcodebuildBeatTerm(input: { root: string; destination: string; derived: string; products: string }): string {
  const { name } = uikitIdentity(input.root)
  const project = join(input.root, 'host', 'uikit', `${name}.xcodeproj`)
  const built = spawnSync(
    'xcodebuild',
    ['build', '-project', project, '-scheme', name, '-configuration', 'Release', '-destination', input.destination, '-derivedDataPath', input.derived, 'CODE_SIGNING_ALLOWED=NO', '-quiet'],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  )
  const app = join(input.derived, 'Build', 'Products', input.products, `${name}.app`)

  if (built.status !== 0 || !existsSync(app)) {
    throw new Error(`xcodebuild ${input.destination} failed (status ${built.status}):\n${errorLines(`${built.stdout}${built.stderr}`)}`)
  }

  return app
}

// term make --target uikit from deck/tool/tool/beat-term, then xcodebuild for the simulator (Release,
// CODE_SIGNING_ALLOWED=NO, derived data in <A>/host/uikit/derived-simulator); throws with xcodebuild's error lines
export async function buildBeatTermForSimulator(): Promise<{ app: string; identifier: string; root: string }> {
  const root = BEAT_TERM_ROOT
  const { name, identifier } = uikitIdentity(root)

  if (name !== 'beatterm' || identifier !== 'surf.term.beatterm') {
    throw new Error(`the app is named ${name} / ${identifier}, not beatterm / surf.term.beatterm`)
  }

  await makeUikit({ root, team: '' })

  const app = xcodebuildBeatTerm({
    root,
    destination: 'generic/platform=iOS Simulator',
    derived: join(root, 'host', 'uikit', 'derived-simulator'),
    products: 'Release-iphonesimulator',
  })

  return { app, identifier, root }
}
