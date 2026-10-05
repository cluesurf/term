// Handing things to the platform in a browser (device-layer-0008), docked by ../open.tree as `<global:native-open>`.
// An address opens in a new tab or window; text goes to navigator.share where the browser has it (phones, Safari).

export const nativeOpen = {
  // opened, or denied when the browser blocked the window, or unavailable outside a browser
  async address(address: string): Promise<string> {
    if (typeof window === 'undefined' || typeof window.open !== 'function') {
      return 'unavailable'
    }

    return window.open(address, '_blank', 'noopener') === null ? 'denied' : 'opened'
  },

  // shown, denied (the browser refused to show it, as it does outside a person's click), or unavailable
  async share(text: string): Promise<string> {
    if (typeof navigator === 'undefined' || typeof navigator.share !== 'function') {
      return 'unavailable'
    }

    try {
      await navigator.share({ text })

      return 'shown'
    } catch (error) {
      // an AbortError is the person closing the sheet, which was shown; anything else is the sheet never coming up
      return (error as Error).name === 'AbortError' ? 'shown' : 'denied'
    }
  },
}
