// The torch in a browser (device-layer-0002), docked by ../torch.tree as `<global:native-torch>`. A browser reaches
// the torch only through a running camera track whose capabilities include `torch` (Chromium on Android), so turning
// it on opens the back camera and keeps it open, and turning it off closes it. Anything else answers `unavailable`.

export const nativeTorch = {
  track: undefined as MediaStreamTrack | undefined,
  // whether a camera track here has ever offered a torch. Until one has, the page cannot know there is a torch without
  // opening the camera, so the state reads `unavailable`, which set-torch answers the same way when the track has none
  seen: false,

  capable(one: MediaStreamTrack): boolean {
    return typeof one.getCapabilities === 'function' && Boolean((one.getCapabilities() as { torch?: boolean }).torch)
  },

  // on, off or unavailable
  async state(): Promise<string> {
    return nativeTorch.track ? 'on' : nativeTorch.seen ? 'off' : 'unavailable'
  },

  // the state after, or unavailable, or denied
  async set(state: string): Promise<string> {
    if (state !== 'on') {
      nativeTorch.track?.stop()
      nativeTorch.track = undefined

      return nativeTorch.seen ? 'off' : 'unavailable'
    }

    if (typeof navigator === 'undefined' || typeof navigator.mediaDevices?.getUserMedia !== 'function') {
      return 'unavailable'
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      const found = stream.getVideoTracks()[0]

      if (!found || !nativeTorch.capable(found)) {
        stream.getTracks().forEach(one => one.stop())

        return 'unavailable'
      }

      await found.applyConstraints({ advanced: [{ torch: true } as MediaTrackConstraintSet] })
      nativeTorch.seen = true
      nativeTorch.track = found

      return 'on'
    } catch (error) {
      return (error as Error).name === 'NotAllowedError' ? 'denied' : 'unavailable'
    }
  },
}
