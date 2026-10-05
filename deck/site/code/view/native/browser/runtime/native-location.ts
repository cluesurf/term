// Location in a browser (device-layer-0004), docked by ../location.tree as `<global:native-location>`.
// navigator.geolocation, once, which prompts for the grant itself when it has none.

export const nativeLocation = {
  // `<latitude> <longitude> <accuracy>`, or denied, unavailable or failed
  position(): Promise<string> {
    if (typeof navigator === 'undefined' || typeof navigator.geolocation?.getCurrentPosition !== 'function') {
      return Promise.resolve('unavailable')
    }

    return new Promise(settle =>
      navigator.geolocation.getCurrentPosition(
        at => settle(`${at.coords.latitude.toFixed(6)} ${at.coords.longitude.toFixed(6)} ${Math.round(at.coords.accuracy)}`),
        error => settle(error.code === error.PERMISSION_DENIED ? 'denied' : 'failed'),
        { enableHighAccuracy: true, timeout: 10_000 },
      ),
    )
  },
}
