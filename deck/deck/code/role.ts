import { RoleConfig, RoleRule } from './form'

/**
 * Parse a role file that maps glob patterns to mill names.
 *
 * Example role file:
 *
 *   role book
 *     take ~/book/**\/*.tree
 *       miss ~/book/**\/{code,view}/**\/*.tree
 *
 *   role code
 *     take ~/code/**\/*.tree
 *     take ~/book/**\/{code,view}/**\/*.tree
 */
export function parseRoleFile(input: {
  text: string
  root: string
}): RoleConfig {
  const { text, root } = input
  const lines = text.split('\n')
  const rules: Array<RoleRule> = []

  let i = 0
  while (i < lines.length) {
    const raw = lines[i]!
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    i++

    if (!line || line.startsWith('#') || line.startsWith('load ')) {
      // Skip empty lines, comments, and load directives
      // (load directives declare which vocabularies are available
      //  but we don't need to resolve them here)
      if (line.startsWith('load ')) {
        // Skip child lines of load
        while (i < lines.length) {
          const nextRaw = lines[i]!
          const nextIndent = nextRaw.length - nextRaw.trimStart().length
          const nextLine = nextRaw.trim()
          if (!nextLine || nextLine.startsWith('#')) {
            i++
            continue
          }
          if (nextIndent <= indent) break
          i++
        }
      }
      continue
    }

    if (line.startsWith('role ')) {
      const name = line.slice(5).trim()
      const take: Array<{ pattern: string; miss: Array<string> }> = []

      // Parse children (take/miss lines)
      while (i < lines.length) {
        const nextRaw = lines[i]!
        const nextIndent = nextRaw.length - nextRaw.trimStart().length
        const nextLine = nextRaw.trim()
        if (!nextLine || nextLine.startsWith('#')) {
          i++
          continue
        }
        if (nextIndent <= indent) break

        if (nextLine.startsWith('take ')) {
          const pattern = expandTilde({
            pattern: nextLine.slice(5).trim(),
            root,
          })
          const missPatterns: Array<string> = []
          const takeIndent = nextIndent
          i++

          // Check for miss children under this take
          while (i < lines.length) {
            const missRaw = lines[i]!
            const missIndent =
              missRaw.length - missRaw.trimStart().length
            const missLine = missRaw.trim()
            if (!missLine || missLine.startsWith('#')) {
              i++
              continue
            }
            if (missIndent <= takeIndent) break
            if (missLine.startsWith('miss ')) {
              missPatterns.push(
                expandTilde({
                  pattern: missLine.slice(5).trim(),
                  root,
                }),
              )
            }
            i++
          }

          take.push({ pattern, miss: missPatterns })
          continue
        }

        i++
      }

      rules.push({ name, take })
      continue
    }
  }

  return { rules }
}

/**
 * Match a file path against the role config to determine which mill to use.
 * Returns the mill name (e.g., "code", "book") or null if no match.
 */
export function matchRole(input: {
  filePath: string
  config: RoleConfig
}): string | null {
  const { filePath, config } = input

  for (const rule of config.rules) {
    for (const entry of rule.take) {
      if (globMatch({ pattern: entry.pattern, path: filePath })) {
        // Check miss exclusions
        let excluded = false
        for (const miss of entry.miss) {
          if (globMatch({ pattern: miss, path: filePath })) {
            excluded = true
            break
          }
        }
        if (!excluded) {
          return rule.name
        }
      }
    }
  }

  return null
}

/**
 * Replace ~ prefix with the package root path.
 */
function expandTilde(input: { pattern: string; root: string }): string {
  if (input.pattern.startsWith('~/')) {
    return input.root + input.pattern.slice(1)
  }
  if (input.pattern === '~') {
    return input.root
  }
  return input.pattern
}

/**
 * Simple glob matcher supporting *, **, ?, and {a,b} patterns.
 * Converts glob to regex for matching.
 */
export function globMatch(input: {
  pattern: string
  path: string
}): boolean {
  const regex = globToRegex({ pattern: input.pattern })
  return regex.test(input.path)
}

function globToRegex(input: { pattern: string }): RegExp {
  let result = ''
  let i = 0
  const pat = input.pattern

  while (i < pat.length) {
    const ch = pat[i]!

    if (ch === '*') {
      if (pat[i + 1] === '*') {
        if (pat[i + 2] === '/') {
          // **/ matches zero or more directories
          result += '(?:.+/)?'
          i += 3
        } else {
          // ** matches everything
          result += '.*'
          i += 2
        }
      } else {
        // * matches anything except /
        result += '[^/]*'
        i++
      }
    } else if (ch === '?') {
      result += '[^/]'
      i++
    } else if (ch === '{') {
      // {a,b,c} alternation
      const end = pat.indexOf('}', i)
      if (end === -1) {
        result += '\\{'
        i++
      } else {
        const inner = pat.slice(i + 1, end)
        const alts = inner.split(',').map(a => escapeRegex({ text: a }))
        result += '(?:' + alts.join('|') + ')'
        i = end + 1
      }
    } else if (ch === '[') {
      const end = pat.indexOf(']', i)
      if (end === -1) {
        result += '\\['
        i++
      } else {
        result += pat.slice(i, end + 1)
        i = end + 1
      }
    } else if ('.+^$|()\\'.includes(ch)) {
      result += '\\' + ch
      i++
    } else {
      result += ch
      i++
    }
  }

  return new RegExp('^' + result + '$')
}

function escapeRegex(input: { text: string }): string {
  return input.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
