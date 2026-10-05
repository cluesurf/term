// Location in a browser (device-layer-0004), docked by ../location.tree as `<global:native-location>`.
// navigator.geolocation, which prompts for the grant itself when it has none.

export const nativeLocation = {
  describe(at: GeolocationPosition): string {
    return `${at.coords.latitude.toFixed(6)} ${at.coords.longitude.toFixed(6)} ${Math.round(at.coords.accuracy)}`
  },

  // `<latitude> <longitude> <accuracy>`, or denied, unavailable or failed
  position(): Promise<string> {
    if (typeof navigator === 'undefined' || typeof navigator.geolocation?.getCurrentPosition !== 'function') {
      return Promise.resolve('unavailable')
    }

    return new Promise(settle =>
      navigator.geolocation.getCurrentPosition(
        at => settle(nativeLocation.describe(at)),
        error => settle(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed'),
        { enableHighAccuracy: true, timeout: 10_000 },
      ),
    )
  },

  // every position the browser reports, the first included, to `handler`, until `unwatch` is given the number this
  // answers: one subscription shared by every watcher (native-watch.ts). `denied` or `unavailable` once
  watch(handler: (value: string) => void): number {
    return nativeWatch.join('position', handler, tell => {
      if (typeof navigator === 'undefined' || typeof navigator.geolocation?.watchPosition !== 'function') {
        tell('unavailable')

        return () => {}
      }

      const watching = navigator.geolocation.watchPosition(
        at => tell(nativeLocation.describe(at)),
        error => tell(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed'),
        { enableHighAccuracy: true },
      )

      return () => navigator.geolocation.clearWatch(watching)
    })
  },

  unwatch(id: number): void {
    nativeWatch.leave('position', id)
  },
}
