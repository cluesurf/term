// A local notification shown on iOS (device-layer-0018), through the platform's own prompt. `simctl privacy` grants
// no notifications, so the only way to the grant is the alert SpringBoard puts up, and only a UI test can tap it: an
// XCUITest bundle, written and built here, drives SpringBoard (`XCUIApplication(bundleIdentifier:
// "com.apple.springboard")`), taps Allow when our app's prompt comes up, and then waits for a banner carrying the
// notification's title. That banner is the witness: SpringBoard drew it, the app did not report it.
//
// The app (a UIKit toolkit program) asks for the grant, posts the notification while it is in front, and says what it
// was answered. A notification posted in front is shown only when the app's delegate asks for it, which the runtime
// now does (native-notification.swift `NotificationPresenter`); before that `shown` answered for a banner nobody saw.
//
// Skips, with the reason, without xcodebuild or a simulator. Run: npx tsx test/compile/notification-prompt.ts
import { type ChildProcess, spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

if (spawnSync('xcodebuild', ['-version']).status !== 0) {
  console.log('skip  notification-prompt  (no xcodebuild)')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'term-notification-'))
const TITLE = `Term notice ${process.pid}`
const APP = 'surf.term.notification-prompt-test'
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

// one UI-testing bundle and nothing else: it drives SpringBoard, so it needs no app of its own to test
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

// The taps: Allow on our app's prompt, then the banner. Every element SpringBoard draws is searched, since a banner's
// title is one static text among the app name and the body
const TAPS = `import XCTest

final class Taps: XCTestCase {
    func testAllowThenBanner() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 120), "no notification prompt came up")
        allow.tap()
        let banner = springboard.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "${TITLE}")).firstMatch
        XCTAssertTrue(banner.waitForExistence(timeout: 60), "no banner with the title came up")
        print("taps: allowed, banner shown")
    }
}
`

const project = join(dir, `${RUNNER}.xcodeproj`)
mkdirSync(join(project, 'xcshareddata', 'xcschemes'), { recursive: true })
mkdirSync(join(dir, 'Sources'), { recursive: true })
writeFileSync(join(project, 'project.pbxproj'), PROJECT)
writeFileSync(join(project, 'xcshareddata', 'xcschemes', `${RUNNER}.xcscheme`), SCHEME)
writeFileSync(join(dir, 'Sources', 'Taps.swift'), TAPS)

const derived = join(dir, 'derived')
const built = spawnSync('xcodebuild', ['build-for-testing', '-project', project, '-scheme', RUNNER, '-destination', 'generic/platform=iOS Simulator', '-derivedDataPath', derived, '-quiet'], { encoding: 'utf8', timeout: 600_000 })
ok('the UI test that taps the prompt builds', built.status === 0, `${built.stdout}${built.stderr}`.split('\n').filter(line => /error/.test(line)).join('\n').slice(0, 1600))

const program = (_leg: Leg, _shot: string): string => `load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find say

load @term/site/code/view/permission
  find permission-status
  find request-permission

load @term/site/code/view/notification
  find show-notification

task main
  save root
    call open-root
      text <Term notice>
      code 320
      code 200
  call launch
    task check
      mark async
      save before
        call permission-status
          text <notification>
      call say
        text <step before {before}>
      save asked
        call request-permission
          text <notification>
      call say
        text <step asked {asked}>
      save posted
        call show-notification
          text <${TITLE}>
          text <posted by notification-prompt>
      call say
        text <step posted {posted}>
      call exit-app
        code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

let taps: ChildProcess | undefined
const tapsLog = join(dir, 'taps.log')

// started once the app is installed and before it launches: the UI test waits for the prompt the launch brings up
function prepare(leg: Leg, target: { udid?: string; identifier: string }): void {
  if (leg !== 'ios' || !target.udid || built.status !== 0) {
    return
  }

  const out = openSync(tapsLog, 'w')
  taps = spawn('xcodebuild', ['test-without-building', '-project', project, '-scheme', RUNNER, '-destination', `id=${target.udid}`, '-derivedDataPath', derived], { stdio: ['ignore', out, out] })
  closeSync(out)
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const named = `${leg} (${toolkit})`
  ok(`${named}: before asking, the grant is not-determined`, step(output, 'before') === 'not-determined', step(output, 'before'))
  ok(`${named}: the prompt was tapped, and the request answers granted`, step(output, 'asked') === 'granted', step(output, 'asked'))
  ok(`${named}: the notification is posted`, step(output, 'posted') === 'shown', step(output, 'posted'))
}

async function main(): Promise<void> {
  runToolkits({ root: process.cwd(), dir, name: 'Notice', iosIdentifier: APP, androidIdentifier: 'surf.term.notice', program, judge, ok, shots: {}, prepare }, 'ios')

  if (taps) {
    const child = taps
    const status = child.exitCode ?? (await new Promise<number | null>(settle => child.once('exit', settle)))
    const log = readFileSync(tapsLog, 'utf8')
    // the witness: SpringBoard drew a banner with the notification's title, which only the platform can do
    ok('ios: SpringBoard showed the prompt, took the tap, and drew the banner with its title', status === 0 && log.includes('taps: allowed, banner shown'), log.split('\n').filter(line => /error|failed|XCTAssert/i.test(line)).join('\n').slice(0, 1200))
  }

  console.log(`\nnotification-prompt: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
