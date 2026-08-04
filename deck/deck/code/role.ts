import { RoleConfig, RoleRule } from './form'
import { readTree, formsWith, termsOf } from './read'

/**
 * Parse a role file that maps glob patterns to mill names.
 *
 * Example role file:
 *
 *   role book
 *     take @/book/**\/*.tree
 *       miss @/book/**\/{code,view}/**\/*.tree
 *
 *   role code
 *     take @/code/**\/*.tree
 *     take @/book/**\/{code,view}/**\/*.tree
 */
export function parseRoleFile(input: {
  text: string
  root: string
}): RoleConfig {
  const { text, root } = input
  const result = readTree({ file: 'role.tree', text })

  if (!result.ok) {
    const first = result.diagnostics[0]

    throw new Error(
      `role file could not be parsed${first ? `: ${first.message}` : ''}`,
    )
  }

  const rules: RoleRule[] = []

  // `load` forms declare which vocabularies are available and are not needed here
  for (const form of result.forms) {
    if (form.head !== 'role') {
      continue
    }

    rules.push({
      name: form.terms[0] ?? '',
      take: formsWith(form, 'take').map(entry => ({
        // a glob is either bare (`@/code/**/*.tree`) or quoted when it contains
        // braces (`<@/book/**/\{code,view\}/**/*.tree>`), which read as a value.
        // Terms only, never a phrase walk: a `take` carries `miss` children and a
        // phrase walk would swallow them into the pattern.
        pattern: expandRoot({
          pattern: entry.value ?? termsOf(entry),
          root,
        }),
        miss: formsWith(entry, 'miss').map(m =>
          expandRoot({ pattern: m.value ?? termsOf(m), root }),
        ),
      })),
    })
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
 * Replace the `@` prefix with the package root path. `@` is the package root
 * throughout; `~` is never used.
 */
function expandRoot(input: { pattern: string; root: string }): string {
  if (input.pattern.startsWith('@/')) {
    return input.root + input.pattern.slice(1)
  }

  if (input.pattern === '@') {
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
