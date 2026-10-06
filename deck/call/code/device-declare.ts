// The declarations a platform requires before it grants a device capability (device-layer-0012), derived from the
// capability runtimes a program's native half holds. An app declares exactly what it reaches: a camera permission is in
// the manifest because the camera's runtime is in the program, and absent from every app that never touches it.
//
//   android   the manifest's <uses-permission> lines. A permission it does not declare can never be granted, neither by
//             the person nor by `adb shell pm grant`
//   apple     the Info.plist usage strings. iOS ends an app that asks for a privacy grant without the string, at the
//             first request, with no prompt
//
// A runtime is told by its declaration, `object nativeCamera` in Kotlin and `enum nativeCamera` in Swift
// (view/native/toolkit/runtime/native-*.kt and .swift). The permission module declares nothing on its own: asking for a
// capability's grant is meaningful only in a program that has the capability.

type Declaration = { runtime: string; android: string[]; apple?: { key: string; text: string } }

const DECLARATIONS: Declaration[] = [
  { runtime: 'nativeCamera', android: ['android.permission.CAMERA'], apple: { key: 'NSCameraUsageDescription', text: 'Takes the photos you ask for.' } },
  { runtime: 'nativeMicrophone', android: ['android.permission.RECORD_AUDIO'], apple: { key: 'NSMicrophoneUsageDescription', text: 'Records the sound you ask it to.' } },
  { runtime: 'nativeContacts', android: ['android.permission.READ_CONTACTS'], apple: { key: 'NSContactsUsageDescription', text: 'Finds the people you ask for.' } },
  // iOS 17 and macOS 14 read the full-access string; the build's minimum is those, so the older NSCalendarsUsageDescription is not needed
  {
    runtime: 'nativeCalendar',
    android: ['android.permission.READ_CALENDAR', 'android.permission.WRITE_CALENDAR'],
    apple: { key: 'NSCalendarsFullAccessUsageDescription', text: 'Keeps and finds the events you ask it to.' },
  },
  // READ_MEDIA_IMAGES from Android 13, READ_EXTERNAL_STORAGE before it, and Android 14's choice of photos
  {
    runtime: 'nativePhotos',
    android: ['android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VISUAL_USER_SELECTED', 'android.permission.READ_EXTERNAL_STORAGE'],
    apple: { key: 'NSPhotoLibraryUsageDescription', text: 'Shows and copies the photos you ask for.' },
  },
  { runtime: 'nativeTorch', android: [], apple: { key: 'NSCameraUsageDescription', text: 'Turns on the camera light when you ask for it.' } },
  {
    runtime: 'nativeLocation',
    android: ['android.permission.ACCESS_FINE_LOCATION', 'android.permission.ACCESS_COARSE_LOCATION'],
    apple: { key: 'NSLocationWhenInUseUsageDescription', text: 'Reads where you are when you ask for it.' },
  },
  { runtime: 'nativeNotification', android: ['android.permission.POST_NOTIFICATIONS'] },
  { runtime: 'nativeVibration', android: ['android.permission.VIBRATE'] },
  { runtime: 'nativeNetwork', android: ['android.permission.ACCESS_NETWORK_STATE'] },
  // Face ID refuses an app with no usage string, and Android's BiometricPrompt one without USE_BIOMETRIC (device-layer-0021)
  { runtime: 'nativeBiometric', android: ['android.permission.USE_BIOMETRIC'], apple: { key: 'NSFaceIDUsageDescription', text: 'Checks it is you when you ask it to.' } },
]

const holds = (native: string, runtime: string): boolean => new RegExp(`\\b(object|enum) ${runtime}\\b`).test(native)

// the Android permissions a program's native half needs, each once, in a stable order
export function androidPermissions(native: string): string[] {
  return [...new Set(DECLARATIONS.filter(one => holds(native, one.runtime)).flatMap(one => one.android))].sort()
}

// the Info.plist usage strings a program's native half needs, by key. Two runtimes sharing a key (the camera and its
// light) keep the first one's text
export function appleUsage(native: string): Record<string, string> {
  const usage: Record<string, string> = {}

  for (const one of DECLARATIONS) {
    if (one.apple && holds(native, one.runtime) && !(one.apple.key in usage)) {
      usage[one.apple.key] = one.apple.text
    }
  }

  return usage
}

// the manifest lines for those permissions
export function permissionLines(native: string): string[] {
  return androidPermissions(native).map(permission => `  <uses-permission android:name="${permission}" />`)
}
