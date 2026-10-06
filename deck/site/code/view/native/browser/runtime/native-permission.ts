// Permissions in a browser (device-layer-0001), docked by ../permission.tree as `<global:native-permission>`.
//
// The Permissions API reads a grant (`prompt` is `not-determined`), and each capability's own call asks for it, since a
// browser prompts only from the call that needs the grant: getUserMedia for the camera and the microphone, getCurrentPosition for
// location, Notification.requestPermission for notifications.
//
// Every runtime a page links is joined into one module in front of the program (native.ts `joinTypeScriptPrelude`), so
// nothing here is named at the top level but the object: a helper called `status` would collide with the program's own.

export const nativePermission = {
  queries: { camera: 'camera', microphone: 'microphone', location: 'geolocation', notification: 'notifications' } as Record<string, string>,

  async status(name: string): Promise<string> {
    const query = nativePermission.queries[name]

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
  },

  async request(name: string): Promise<string> {
    try {
      if ((name === 'camera' || name === 'microphone') && typeof navigator.mediaDevices?.getUserMedia === 'function') {
        const stream = await navigator.mediaDevices.getUserMedia(name === 'camera' ? { video: true } : { audio: true })

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

    return nativePermission.status(name)
  },
}
