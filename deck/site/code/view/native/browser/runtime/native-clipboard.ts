// The clipboard in a browser (device-layer-0005), docked by ../clipboard.tree as `<global:native-clipboard>`.
// navigator.clipboard, which exists only on a secure page and answers only with the browser's grant (and, for a write,
// while the page has focus). Outside a browser there is none, and the answers say so.

export const nativeClipboard = {
  live(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.clipboard?.readText === 'function'
  },

  // the text on the clipboard now, or empty text when it holds none or the browser refuses to say
  async read(): Promise<string> {
    if (!nativeClipboard.live()) {
      return ''
    }

    try {
      return await navigator.clipboard.readText()
    } catch {
      return ''
    }
  },

  // `written`, `denied` (no grant, or the page is not focused) or `unavailable` (no clipboard here)
  async write(text: string): Promise<string> {
    if (!nativeClipboard.live()) {
      return 'unavailable'
    }

    try {
      await navigator.clipboard.writeText(text)

      return 'written'
    } catch {
      return 'denied'
    }
  },
}
