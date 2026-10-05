// The battery in a browser (device-layer-0009), docked by ../battery.tree as `<global:native-battery>`.
// navigator.getBattery, which Chromium-based browsers have and Safari and Firefox do not.

type Battery = { level: number; charging: boolean; chargingTime: number }

export const nativeBattery = {
  // `<level> <state>`, or unavailable
  async read(): Promise<string> {
    if (typeof navigator === 'undefined') {
      return 'unavailable'
    }

    const read = (navigator as unknown as { getBattery?: () => Promise<Battery> }).getBattery

    if (typeof read !== 'function') {
      return 'unavailable'
    }

    const battery = await read.call(navigator)
    const state = battery.charging ? (battery.level >= 1 ? 'full' : 'charging') : 'unplugged'

    return `${battery.level.toFixed(2)} ${state}`
  },
}
