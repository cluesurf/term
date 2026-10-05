// Local notifications in a browser (device-layer-0007), docked by ../notification.tree as
// `<global:native-notification>`. The Notification API, shown only with the grant (request-permission notification).

export const nativeNotification = {
  // shown, not-determined, denied, unavailable or failed
  async post(title: string, body: string): Promise<string> {
    if (typeof Notification === 'undefined') {
      return 'unavailable'
    }

    if (Notification.permission !== 'granted') {
      return Notification.permission === 'denied' ? 'denied' : 'not-determined'
    }

    try {
      new Notification(title, { body })

      return 'shown'
    } catch {
      // a page whose notifications must go through a service worker (Chrome on Android)
      return 'failed'
    }
  },
}
