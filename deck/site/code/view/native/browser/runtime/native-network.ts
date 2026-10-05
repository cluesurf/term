// The network in a browser (device-layer-0010), docked by ../network.tree as `<global:native-network>`.
// navigator.onLine, and the Network Information API's kind where the browser has it (Chromium on Android); elsewhere
// the kind is `other`.

const KINDS: Record<string, string> = { wifi: 'wifi', cellular: 'cellular', ethernet: 'wired' }

export const nativeNetwork = {
  // `<online|offline> <kind>`
  async read(): Promise<string> {
    if (typeof navigator === 'undefined') {
      return 'unavailable'
    }

    if (!navigator.onLine) {
      return 'offline none'
    }

    const type = (navigator as unknown as { connection?: { type?: string } }).connection?.type

    return `online ${(type && KINDS[type]) ?? 'other'}`
  },
}
