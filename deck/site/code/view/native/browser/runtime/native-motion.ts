// Motion in a browser (device-layer-0011), docked by ../motion.tree as `<global:native-motion>`. One
// devicemotion event's acceleration with gravity, in metres per second squared. A browser with no accelerometer sends
// none, so a second without one answers `unavailable`.

export const nativeMotion = {
  // how long to wait for the first event, in milliseconds
  wait: 1000,

  // `<x> <y> <z>` of one event, or nothing when it carries no acceleration
  describe(event: DeviceMotionEvent): string | undefined {
    const a = event.accelerationIncludingGravity

    return a?.x == null || a.y == null || a.z == null ? undefined : `${a.x.toFixed(2)} ${a.y.toFixed(2)} ${a.z.toFixed(2)}`
  },

  // `<x> <y> <z>`, or unavailable
  sample(): Promise<string> {
    if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
      return Promise.resolve('unavailable')
    }

    return new Promise(settle => {
      const heard = (event: DeviceMotionEvent): void => {
        const said = nativeMotion.describe(event)

        if (said === undefined) {
          return
        }

        window.removeEventListener('devicemotion', heard)
        clearTimeout(timer)
        settle(said)
      }
      const timer = setTimeout(() => {
        window.removeEventListener('devicemotion', heard)
        settle('unavailable')
      }, nativeMotion.wait)

      window.addEventListener('devicemotion', heard)
    })
  },

  // every devicemotion event's acceleration with gravity, to `handler`, until `unwatch` is given the number this
  // answers: one subscription shared by every watcher (native-watch.ts). `unavailable` once when none comes within a
  // second, as a browser with no accelerometer sends none
  watch(handler: (value: string) => void): number {
    return nativeWatch.join('motion', handler, tell => {
      if (typeof window === 'undefined' || typeof DeviceMotionEvent === 'undefined') {
        tell('unavailable')

        return () => {}
      }

      let heard = false
      const listen = (event: DeviceMotionEvent): void => {
        const said = nativeMotion.describe(event)

        if (said !== undefined) {
          heard = true
          tell(said)
        }
      }
      const timer = setTimeout(() => heard || tell('unavailable'), nativeMotion.wait)
      window.addEventListener('devicemotion', listen)

      return () => {
        clearTimeout(timer)
        window.removeEventListener('devicemotion', listen)
      }
    })
  },

  unwatch(id: number): void {
    nativeWatch.leave('motion', id)
  },
}
