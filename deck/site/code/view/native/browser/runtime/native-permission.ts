// Permissions in a browser (device-layer-0001), docked by ../permission.tree as `<global:native-permission>`.
//
// The Permissions API reads a grant (`prompt` is `not-determined`), and each capability's own call asks for it, since a
// browser prompts only from the call that needs the grant: getUserMedia for the camera, getCurrentPosition for
// location, Notification.requestPermission for notifications.

const QUERIES: Record<string, string> = { camera: 'camera', location: 'geolocation', notification: 'notifications' }

async function status(name: string): Promise<string> {
  const query = QUERIES[name]

  if (!query || typeof navigator === 'undefined' || typeof navigator.permissions?.query !== 'function') {
    return 'unavailable'
  }

  try {
    const state = (await navigator.permissions.query({ name: query as PermissionName })).state

    return state === 'prompt' ? 'not-determined' : state
  } catch {
    // a name this browser does not know (Firefox and `camera`)
    return 'unavailable'
  }
}

async function request(name: string): Promise<string> {
  try {
    if (name === 'camera' && typeof navigator.mediaDevices?.getUserMedia === 'function') {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })

      for (const track of stream.getTracks()) {
        track.stop()
      }
    } else if (name === 'location' && typeof navigator.geolocation?.getCurrentPosition === 'function') {
      await new Promise<void>(settle => navigator.geolocation.getCurrentPosition(() => settle(), () => settle()))
    } else if (name === 'notification' && typeof Notification !== 'undefined') {
      await Notification.requestPermission()
    }
  } catch {
    // a refusal is an answer: the status says which
  }

  return status(name)
}

export const nativePermission = { status, request }
