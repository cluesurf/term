// Vibration in a browser (device-layer-0006), docked by ../vibration.tree as `<global:native-vibration>`.
// navigator.vibrate, which Chromium on Android plays and desktop browsers and Safari do not have.

export const nativeVibration = {
  patterns: {
    light: [10],
    medium: [20],
    heavy: [40],
    success: [20, 60, 20],
    warning: [40, 60, 40],
    error: [60, 50, 60, 50, 60],
  } as Record<string, number[]>,

  // `played`, or `unavailable`
  async play(kind: string): Promise<string> {
    const pattern = nativeVibration.patterns[kind]

    if (!pattern || typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') {
      return 'unavailable'
    }

    return navigator.vibrate(pattern) ? 'played' : 'unavailable'
  },
}
