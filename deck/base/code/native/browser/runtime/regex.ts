// Regex shim over the host RegExp. Wraps construction so the native module can dock a uniform `regex` namespace.
const regex = {
  matches: (pattern: string, text: string): boolean =>
    new RegExp(pattern).test(text),
  replace: (
    pattern: string,
    text: string,
    replacement: string,
  ): string => text.replace(new RegExp(pattern, 'g'), replacement),
  find: (pattern: string, text: string): string => {
    const m = text.match(new RegExp(pattern))
    return m ? m[0] : ''
  },
}
