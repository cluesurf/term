// A UI test that taps what SpringBoard puts up on the iPhone simulator: a grant's prompt, which `simctl privacy` cannot
// answer for some grants (notifications, and on iOS 26 the photo library), and a banner to wait for. One UI-testing
// bundle and nothing else, written and built here with xcodebuild, driving SpringBoard
// (`XCUIApplication(bundleIdentifier: "com.apple.springboard")`), so it needs no app of its own to test. The caller
// gives the test's body; it is started once the app is installed and before it launches, and waits for the prompt the
// launch brings up. A helper, not a suite: shared/ is not walked by the runner. Used by test/compile/notification-prompt.ts
// and test/compile/photos-prompt.ts.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RUNNER = 'TermPromptTaps'

// an Xcode object id: 24 hex digits, the same for the same name
const id = (name: string): string => createHash('sha256').update(name).digest('hex').slice(0, 24).toUpperCase()

const ids = {
  file: id('file'),
  build: id('build'),
  product: id('product'),
  main: id('main'),
  sources: id('sources'),
  products: id('products'),
  phase: id('phase'),
  target: id('target'),
  targetList: id('target-list'),
  targetDebug: id('target-debug'),
  project: id('project'),
  projectList: id('project-list'),
  projectDebug: id('project-debug'),
}

const settings = (entries: Record<string, string>): string =>
  Object.entries(entries)
    .map(([key, value]) => `\t\t\t\t${key} = "${value}";`)
    .join('\n')

const PROJECT = `// !$*UTF8*$!
{
	archiveVersion = 1;
	classes = {
	};
	objectVersion = 56;
	objects = {
		${ids.build} = {isa = PBXBuildFile; fileRef = ${ids.file}; };
		${ids.file} = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = Taps.swift; sourceTree = "<group>"; };
		${ids.product} = {isa = PBXFileReference; explicitFileType = wrapper.cfbundle; includeInIndex = 0; path = "${RUNNER}.xctest"; sourceTree = BUILT_PRODUCTS_DIR; };
		${ids.main} = {isa = PBXGroup; children = (${ids.sources}, ${ids.products}, ); sourceTree = "<group>"; };
		${ids.sources} = {isa = PBXGroup; children = (${ids.file}, ); path = Sources; sourceTree = "<group>"; };
		${ids.products} = {isa = PBXGroup; children = (${ids.product}, ); name = Products; sourceTree = "<group>"; };
		${ids.phase} = {isa = PBXSourcesBuildPhase; buildActionMask = 2147483647; files = (${ids.build}, ); runOnlyForDeploymentPostprocessing = 0; };
		${ids.target} = {isa = PBXNativeTarget; buildConfigurationList = ${ids.targetList}; buildPhases = (${ids.phase}, ); buildRules = (); dependencies = (); name = "${RUNNER}"; productName = "${RUNNER}"; productReference = ${ids.product}; productType = "com.apple.product-type.bundle.ui-testing"; };
		${ids.targetList} = {isa = XCConfigurationList; buildConfigurations = (${ids.targetDebug}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
		${ids.targetDebug} = {isa = XCBuildConfiguration; buildSettings = {
${settings({
  CODE_SIGN_IDENTITY: '-',
  CODE_SIGN_STYLE: 'Manual',
  GENERATE_INFOPLIST_FILE: 'YES',
  IPHONEOS_DEPLOYMENT_TARGET: '17.0',
  PRODUCT_BUNDLE_IDENTIFIER: 'surf.term.prompt-taps',
  PRODUCT_NAME: '$(TARGET_NAME)',
  SDKROOT: 'iphoneos',
  SWIFT_VERSION: '5.0',
  TARGETED_DEVICE_FAMILY: '1,2',
})}
			}; name = Debug; };
		${ids.project} = {isa = PBXProject; attributes = {BuildIndependentTargetsInParallel = 1; LastUpgradeCheck = 1500; }; buildConfigurationList = ${ids.projectList}; compatibilityVersion = "Xcode 14.0"; developmentRegion = en; hasScannedForEncodings = 0; knownRegions = (en, Base, ); mainGroup = ${ids.main}; productRefGroup = ${ids.products}; projectDirPath = ""; projectRoot = ""; targets = (${ids.target}, ); };
		${ids.projectList} = {isa = XCConfigurationList; buildConfigurations = (${ids.projectDebug}, ); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
		${ids.projectDebug} = {isa = XCBuildConfiguration; buildSettings = {
${settings({ SDKROOT: 'iphoneos', IPHONEOS_DEPLOYMENT_TARGET: '17.0' })}
			}; name = Debug; };
	};
	rootObject = ${ids.project};
}
`

const reference = `<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="${ids.target}" BuildableName="${RUNNER}.xctest" BlueprintName="${RUNNER}" ReferencedContainer="container:${RUNNER}.xcodeproj"/>`

const SCHEME = `<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1500" version="1.7">
  <BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES">
    <BuildActionEntries>
      <BuildActionEntry buildForTesting="YES" buildForRunning="NO" buildForProfiling="NO" buildForArchiving="NO" buildForAnalyzing="NO">
        ${reference}
      </BuildActionEntry>
    </BuildActionEntries>
  </BuildAction>
  <TestAction buildConfiguration="Debug" selectedDebuggerIdentifier="" selectedLauncherIdentifier="Xcode.IDEFoundation.Launcher.PosixSpawn" shouldUseLaunchSchemeArgsEnv="YES">
    <Testables>
      <TestableReference skipped="NO">
        ${reference}
      </TestableReference>
    </Testables>
  </TestAction>
</Scheme>
`

export type Taps = {
  // whether the bundle built, and xcodebuild's error lines when it did not
  built: boolean
  errors: string
  // start the test on the simulator `udid`; it runs while the app does
  start: (udid: string) => void
  // once the app has gone: the test's exit status and its log, or undefined when it was never started
  // `timeout` ms (default 180 s) bounds the wait: past it the test is ended and the log says `timed out`
  finish: (timeout?: number) => Promise<{ status: number | null; log: string } | undefined>
}

// write and build the UI test in `dir`, its one test method's body `body`, Swift under `import XCTest` with `springboard`
// in scope
export function buildTaps(dir: string, body: string): Taps {
  const project = join(dir, `${RUNNER}.xcodeproj`)
  mkdirSync(join(project, 'xcshareddata', 'xcschemes'), { recursive: true })
  mkdirSync(join(dir, 'Sources'), { recursive: true })
  writeFileSync(join(project, 'project.pbxproj'), PROJECT)
  writeFileSync(join(project, 'xcshareddata', 'xcschemes', `${RUNNER}.xcscheme`), SCHEME)
  writeFileSync(
    join(dir, 'Sources', 'Taps.swift'),
    ['import XCTest', '', 'final class Taps: XCTestCase {', '    func testTaps() {', '        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")', body, '    }', '}', ''].join('\n'),
  )

  const derived = join(dir, 'derived')
  const made = spawnSync('xcodebuild', ['build-for-testing', '-project', project, '-scheme', RUNNER, '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, '-quiet'], { encoding: 'utf8', timeout: 600_000 })
  const log = join(dir, 'taps.log')
  let child: ChildProcess | undefined

  return {
    built: made.status === 0,
    errors: `${made.stdout}${made.stderr}`.split('\n').filter(line => /error/.test(line)).join('\n').slice(0, 1600),
    start(udid: string): void {
      const out = openSync(log, 'w')
      child = spawn('xcodebuild', ['test-without-building', '-project', project, '-scheme', RUNNER, '-destination', `id=${udid}`, '-derivedDataPath', derived], { stdio: ['ignore', out, out] })
      closeSync(out)
    },
    // past `timeout` ms the xcodebuild child is ended (SIGTERM, SIGKILL 5 s later) and the answer is a non-zero status with
    // `timed out` in the log, so a test that never finishes cannot hold the shared simulator for ever
    async finish(timeout = 180_000) {
      if (!child) return undefined

      const running = child
      let timedOut = false
      let status: number | null

      if (running.exitCode !== null || running.signalCode !== null) {
        status = running.exitCode
      } else {
        status = await new Promise<number | null>(settle => {
          let hard: ReturnType<typeof setTimeout> | undefined
          const term = setTimeout(() => {
            timedOut = true
            running.kill('SIGTERM')
            hard = setTimeout(() => running.kill('SIGKILL'), 5000)
          }, timeout)

          // the child has exited by its code OR by a signal (the code is then null)
          running.once('exit', code => {
            clearTimeout(term)
            clearTimeout(hard)
            settle(code)
          })
        })
      }

      const text = readFileSync(log, 'utf8')

      return timedOut ? { status: status || 1, log: `${text}\ntimed out after ${timeout} ms\n` } : { status, log: text }
    },
  }
}
