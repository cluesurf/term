// The network in a browser (device-layer-0010), docked by ../network.tree as `<global:native-network>`.
// navigator.onLine, and the Network Information API's kind where the browser has it (Chromium on Android); elsewhere
// the kind is `other`.

export const nativeNetwork = {
  kinds: { wifi: 'wifi', cellular: 'cellular', ethernet: 'wired' } as Record<string, string>,

  // `<online|offline> <kind>`
  async read(): Promise<string> {
    if (typeof navigator === 'undefined') {
      return 'unavailable'
    }

    if (!navigator.onLine) {
      return 'offline none'
    }

    const type = (navigator as unknown as { connection?: { type?: string } }).connection?.type

    return `online ${(type && nativeNetwork.kinds[type]) ?? 'other'}`
  },

  // the network now, and again when the window goes online or offline, to `handler`, until `unwatch` is given the
  // number this answers: one subscription shared by every watcher (native-watch.ts)
  watch(handler: (value: string) => void): number {
    return nativeWatch.join('network', handler, tell => {
      if (typeof window === 'undefined') {
        tell('unavailable')

        return () => {}
      }

      const report = (): void => void nativeNetwork.read().then(tell)
      report()
      window.addEventListener('online', report)
      window.addEventListener('offline', report)

      return () => {
        window.removeEventListener('online', report)
        window.removeEventListener('offline', report)
      }
    })
  },

  unwatch(id: number): void {
    nativeWatch.leave('network', id)
  },
}
