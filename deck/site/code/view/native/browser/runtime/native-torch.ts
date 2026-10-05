// The torch in a browser (device-layer-0002), docked by ../torch.tree as `<global:native-torch>`. A browser reaches
// the torch only through a running camera track whose capabilities include `torch` (Chromium on Android), so turning
// it on opens the back camera and keeps it open, and turning it off closes it. Anything else answers `unavailable`.

let track: MediaStreamTrack | undefined

const capable = (one: MediaStreamTrack): boolean =>
  typeof one.getCapabilities === 'function' && Boolean((one.getCapabilities() as { torch?: boolean }).torch)

export const nativeTorch = {
  // on, off or unavailable
  async state(): Promise<string> {
    if (track) {
      return 'on'
    }

    return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function' ? 'off' : 'unavailable'
  },

  // the state after, or unavailable, or denied
  async set(state: string): Promise<string> {
    if (state !== 'on') {
      track?.stop()
      track = undefined

      return 'off'
    }

    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return 'unavailable'
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const found = stream.getVideoTracks()[0]

      if (!found || !capable(found)) {
        stream.getTracks().forEach(one => one.stop())

        return 'unavailable'
      }

      await found.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] })
      track = found

      return 'on'
    } catch (error) {
      return (error as Error).name === 'NotAllowedError' ? 'denied' : 'unavailable'
    }
  },
}
