// Rune (Unicode code point) predicates and case mapping, powered by the host's Unicode tables (regex property escapes
// and String case mapping). Each takes a code point and returns a boolean, or the mapped code point. Reached only
// through the public rune API.
const rune = {
  isLetter: (code: number): boolean => /\p{L}/u.test(String.fromCodePoint(code)),
  isNumber: (code: number): boolean => /\p{N}/u.test(String.fromCodePoint(code)),
  isWhitespace: (code: number): boolean =>
    /\s/u.test(String.fromCodePoint(code)),
  isUppercase: (code: number): boolean =>
    /\p{Lu}/u.test(String.fromCodePoint(code)),
  isLowercase: (code: number): boolean =>
    /\p{Ll}/u.test(String.fromCodePoint(code)),
  isAlphanumeric: (code: number): boolean =>
    /[\p{L}\p{N}]/u.test(String.fromCodePoint(code)),
  isControl: (code: number): boolean =>
    /\p{Cc}/u.test(String.fromCodePoint(code)),
  toUppercase: (code: number): number =>
    String.fromCodePoint(code).toUpperCase().codePointAt(0) ?? code,
  toLowercase: (code: number): number =>
    String.fromCodePoint(code).toLowerCase().codePointAt(0) ?? code,
}
