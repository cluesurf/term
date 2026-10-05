// The battery in a browser (device-layer-0009), docked by ../battery.tree as `<global:native-battery>`.
// navigator.getBattery, which Chromium-based browsers have and Safari and Firefox do not.

export const nativeBattery = {
  // the browser's battery manager, or nothing where it has none
  manager(): Promise<{ level: number; charging: boolean } & EventTarget> | undefined {
    const read = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { getBattery?: () => Promise<{ level: number; charging: boolean } & EventTarget> }).getBattery

    return typeof read === 'function' ? read.call(navigator) : undefined
  },

  // `<level> <state>`, or unavailable
  async read(): Promise<string> {
    const manager = nativeBattery.manager()

    if (!manager) {
      return 'unavailable'
    }

    const battery = await manager
    const state = battery.charging ? (battery.level >= 1 ? 'full' : 'charging') : 'unplugged'

    return `${battery.level.toFixed(2)} ${state}`
  },

  // the battery now, and again at every level or charging change, to `handler`, until `unwatch` is given the number
  // this answers: one subscription shared by every watcher (native-watch.ts). `unavailable` once without one
  watch(handler: (value: string) => void): number {
    return nativeWatch.join('battery', handler, tell => {
      const manager = nativeBattery.manager()

      if (!manager) {
        tell('unavailable')

        return () => {}
      }

      const report = (): void => void nativeBattery.read().then(tell)
      let ended = false
      let end = (): void => {
        ended = true
      }
      void manager.then(battery => {
        if (ended) {
          return
        }

        report()
        battery.addEventListener('levelchange', report)
        battery.addEventListener('chargingchange', report)
        end = () => {
          battery.removeEventListener('levelchange', report)
          battery.removeEventListener('chargingchange', report)
        }
      })

      return () => end()
    })
  },

  unwatch(id: number): void {
    nativeWatch.leave('battery', id)
  },
}
