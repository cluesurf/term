// The declarations a platform requires before it grants a device capability (device-layer-0012), derived from the
// capability runtimes a program's native half holds. An app declares exactly what it reaches: a camera permission is in
// the manifest because the camera's runtime is in the program, and absent from every app that never touches it.
//
// The table and every decision on it are Term since 2026-10-06, call/code/device-grant.tree. This face keeps the shapes
// its callers know: the usage strings as a record by key.

import * as port from '@term/call/code/device-grant'

// the Android permissions a program's native half needs, each once, in a stable order
export function androidPermissions(native: string): string[] {
  return port.androidPermissions(native)
}

// the Info.plist usage strings a program's native half needs, by key. Two runtimes sharing a key (the camera and its
// light) keep the first one's text
export function appleUsage(native: string): Record<string, string> {
  const usage: Record<string, string> = {}

  for (const one of port.appleUsage(native)) {
    usage[one.key] = one.text
  }

  return usage
}

// the manifest lines for those permissions
export function permissionLines(native: string): string[] {
  return port.permissionLines(native)
}
