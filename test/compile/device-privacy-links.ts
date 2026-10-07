// An app links a privacy framework only when it links the capability that needs it (device-layer-0012).
//
// App Store processing refuses a binary that references a privacy API without the Info.plist usage string for it
// (ITMS-90683). The permission runtime is linked into every app that asks for any grant, and it used to read every grant
// itself, so an app that only posted notifications referenced CoreLocation and AVFoundation with neither usage string.
// Now each capability registers its own grant (native-permission.swift), and this holds it: one program per capability,
// compiled for iOS with its real prelude, must import exactly that capability's privacy frameworks, and the
// declarations the build writes for it (device-declare.ts `appleUsage`) must name a usage string for each one that
// needs one. Needs no toolchain. Run: npx tsx test/compile/device-privacy-links.ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import { appleUsage } from '@term/call/code/device-declare'

const ROOT = join(import.meta.dirname, '..', '..')

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

// the frameworks App Store processing reads as privacy APIs, each with the usage string that must stand beside it
// (none: the framework needs a grant, but no string)
const PRIVACY: Record<string, string | undefined> = {
  AVFoundation: undefined,
  CoreLocation: 'NSLocationWhenInUseUsageDescription',
  Contacts: 'NSContactsUsageDescription',
  EventKit: 'NSCalendarsFullAccessUsageDescription',
  Photos: 'NSPhotoLibraryUsageDescription',
  UserNotifications: undefined,
  LocalAuthentication: 'NSFaceIDUsageDescription',
  Speech: 'NSSpeechRecognitionUsageDescription',
}

// one capability, the task it calls, its arguments as written, the privacy frameworks it may import, and the usage
// strings it must be declared with (AVFoundation's string depends on what is captured, so it is named per capability)
type Case = { module: string; task: string; args: string[]; frameworks: string[]; usage: string[] }

const CASES: Case[] = [
  { module: 'permission', task: 'permission-status', args: ['text <camera>'], frameworks: [], usage: [] },
  { module: 'notification', task: 'show-notification', args: ['text <a>', 'text <b>'], frameworks: ['UserNotifications'], usage: [] },
  { module: 'camera', task: 'take-photo', args: [], frameworks: ['AVFoundation'], usage: ['NSCameraUsageDescription'] },
  { module: 'torch', task: 'torch-state', args: [], frameworks: ['AVFoundation'], usage: ['NSCameraUsageDescription'] },
  { module: 'microphone', task: 'record-audio', args: ['code 1'], frameworks: ['AVFoundation'], usage: ['NSMicrophoneUsageDescription'] },
  { module: 'audio', task: 'audio-length', args: ['text <a>'], frameworks: ['AVFoundation'], usage: ['NSMicrophoneUsageDescription'] },
  { module: 'location', task: 'current-position', args: [], frameworks: ['CoreLocation'], usage: ['NSLocationWhenInUseUsageDescription'] },
  { module: 'contacts', task: 'find-contacts', args: ['text <a>'], frameworks: ['Contacts'], usage: ['NSContactsUsageDescription'] },
  { module: 'calendar', task: 'find-events', args: ['text <a>', 'text <b>'], frameworks: ['EventKit'], usage: ['NSCalendarsFullAccessUsageDescription'] },
  { module: 'photos', task: 'find-photos', args: ['code 1'], frameworks: ['Photos'], usage: ['NSPhotoLibraryUsageDescription'] },
  { module: 'biometric', task: 'biometric-kind', args: [], frameworks: ['LocalAuthentication'], usage: ['NSFaceIDUsageDescription'] },
  { module: 'clipboard', task: 'read-clipboard', args: [], frameworks: [], usage: [] },
  { module: 'battery', task: 'battery-status', args: [], frameworks: [], usage: [] },
  { module: 'network', task: 'network-status', args: [], frameworks: [], usage: [] },
  { module: 'vibration', task: 'vibrate', args: ['text <light>'], frameworks: [], usage: [] },
  { module: 'secret', task: 'read-secret', args: ['text <a>'], frameworks: [], usage: [] },
]

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

for (const one of CASES) {
  // every program also asks the permission module, so a grant it reads is one the capability registered or none
  const text = [
    `load @term/site/code/view/${one.module}`,
    `  find ${one.task}`,
    '',
    'load @term/site/code/view/permission',
    '  find permission-status',
    '',
    'task main',
    '  mark async',
    '  save asked',
    '    call permission-status',
    '      text <camera>',
    '  save said',
    `    call ${one.task}`,
    ...one.args.map(arg => `      ${arg}`),
    '',
  ].join('\n')
  const result = compile({ file: join(ROOT, 'tmp', `privacy-${one.module}.tree`), text }, { resolve: projectResolver(ROOT, 'ios'), env: 'ios' })

  if (!result.ok) {
    ok(`${one.module}: compiles for iOS`, false, result.diagnostics.slice(0, 3).map(d => d.message).join('; '))
    continue
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, 'ios', readRuntime, swift)
  const imported = [...new Set([...prelude.matchAll(/^import (\w+)/gm)].map(m => m[1]!))].filter(name => name in PRIVACY).sort()
  ok(`${one.module}: links ${one.frameworks.join(', ') || 'no privacy framework'}`, imported.join(',') === [...one.frameworks].sort().join(','), imported.join(', ') || 'none')

  const declared = appleUsage(prelude)
  const owed = [...new Set([...one.usage, ...imported.map(name => PRIVACY[name]).filter((key): key is string => key !== undefined)])]
  ok(`${one.module}: and is declared with ${owed.join(', ') || 'no usage string'}`, owed.every(key => key in declared), Object.keys(declared).join(', ') || 'none')
}

console.log(`\ndevice-privacy-links: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
