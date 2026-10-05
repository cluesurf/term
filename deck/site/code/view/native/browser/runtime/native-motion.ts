// Motion in a browser (device-layer-0011), docked by ../motion.tree as `<global:native-motion>`. One
// devicemotion event's acceleration with gravity, in metres per second squared. A browser with no accelerometer sends
// none, so a second without one answers `unavailable`.

// how long to wait for the first event, in milliseconds
const WAIT = 1000

export const nativeMotion = {
  // `<x> <y> <z>`, or unavailable
  sample(): Promise<string> {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
      return Promise.resolve('unavailable')
    }

    return new Promise(settle => {
      const heard = (event: DeviceMotionEvent): void => {
        const a = event.accelerationIncludingGravity

        if (a?.x == null || a.y == null || a.z == null) {
          return
        }

        window.removeEventListener('devicemotion', heard)
        clearTimeout(timer)
        settle(`${a.x.toFixed(2)} ${a.y.toFixed(2)} ${a.z.toFixed(2)}`)
      }
      const timer = setTimeout(() => {
        window.removeEventListener('devicemotion', heard)
        settle('unavailable')
      }, WAIT)

      window.addEventListener('devicemotion', heard)
    })
  },
}
