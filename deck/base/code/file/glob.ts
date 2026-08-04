// A small glob matcher for file-path rules in a `role base` config. It supports the
// familiar subset: `*` (any run within a path segment), `?` (one non-slash char),
// `**` (any run across segments), and a leading `**/` that also matches zero segments.
// That is enough to say "ignore build output" (`build/**`) or "these generated files"
// (`**/*.js`, `**/*.css`). No dependency, and the pattern is compiled once.

const REGEX_SPECIAL = new Set(['.', '+', '^', '$', '{', '}', '(', ')', '|', '[', ']', '\\'])

function globToRegExp(glob: string): RegExp {
  let out = '^'
  let i = 0
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?' // zero or more leading path segments
      i += 3
    } else if (glob.startsWith('**', i)) {
      out += '.*' // any run, across segments
      i += 2
    } else if (glob[i] === '*') {
      out += '[^/]*' // any run within one segment
      i += 1
    } else if (glob[i] === '?') {
      out += '[^/]'
      i += 1
    } else if (REGEX_SPECIAL.has(glob[i]!)) {
      out += `\\${glob[i]}`
      i += 1
    } else {
      out += glob[i]
      i += 1
    }
  }
  out += '$'
  return new RegExp(out)
}

// Compile a set of globs into a single predicate, memoizing the regexes.
export function globMatcher(patterns: Array<string>): (path: string) => boolean {
  const regexps = patterns.map(globToRegExp)
  return (path: string): boolean => regexps.some(re => re.test(path))
}

export function matchesGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path)
}
