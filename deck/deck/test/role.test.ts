import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseRoleFile,
  matchRole,
  matchRoleRule,
  globMatch,
} from '../code/role'

describe('parseRoleFile', () => {
  it('parses basic role definitions', () => {
    const text = `
role book
  take @/book/**/*.tree

role code
  take @/code/**/*.tree
`
    const config = parseRoleFile({ text, root: '/project' })
    expect(config.rules).toHaveLength(2)
    expect(config.rules[0]!.name).toBe('book')
    expect(config.rules[0]!.take).toHaveLength(1)
    expect(config.rules[0]!.take[0]!.pattern).toBe('/project/book/**/*.tree')
    expect(config.rules[1]!.name).toBe('code')
    expect(config.rules[1]!.take[0]!.pattern).toBe('/project/code/**/*.tree')
  })

  it('parses take with miss exclusions', () => {
    const text = `
role book
  take @/book/**/*.tree
    miss @/book/**/\\{code,view\\}/**/*.tree
`
    const config = parseRoleFile({ text, root: '/project' })
    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]!.take[0]!.miss).toHaveLength(1)
    expect(config.rules[0]!.take[0]!.miss[0]).toBe(
      '/project/book/**/{code,view}/**/*.tree',
    )
  })

  it('parses multiple take entries per role', () => {
    const text = `
role code
  take @/code/**/*.tree
  take @/book/**/\\{code,view\\}/**/*.tree
`
    const config = parseRoleFile({ text, root: '/project' })
    expect(config.rules[0]!.take).toHaveLength(2)
  })

  it('skips load blocks', () => {
    const text = `
load @cluesurf/code
  find code
  find book

role code
  take @/code/**/*.tree
`
    const config = parseRoleFile({ text, root: '/project' })
    expect(config.rules).toHaveLength(1)
    expect(config.rules[0]!.name).toBe('code')
  })

  it('skips comments and empty lines', () => {
    const text = `
# This is a comment

role code
  take @/code/**/*.tree
  # another comment
`
    const config = parseRoleFile({ text, root: '/project' })
    expect(config.rules).toHaveLength(1)
  })
})

describe('matchRole', () => {
  const config = parseRoleFile({
    text: `
role book
  take @/book/**/*.tree
    miss @/book/**/\\{code,view\\}/**/*.tree

role code
  take @/code/**/*.tree
  take @/book/**/\\{code,view\\}/**/*.tree
`,
    root: '/project',
  })

  it('matches code files', () => {
    expect(
      matchRole({ filePath: '/project/code/base.tree', config }),
    ).toBe('code')
  })

  it('matches nested code files', () => {
    expect(
      matchRole({ filePath: '/project/code/math/add.tree', config }),
    ).toBe('code')
  })

  it('matches book files', () => {
    expect(
      matchRole({ filePath: '/project/book/intro.tree', config }),
    ).toBe('book')
  })

  it('excludes code subdirs within book from book role', () => {
    expect(
      matchRole({
        filePath: '/project/book/chapter/code/example.tree',
        config,
      }),
    ).toBe('code')
  })

  it('excludes view subdirs within book from book role', () => {
    expect(
      matchRole({
        filePath: '/project/book/chapter/view/demo.tree',
        config,
      }),
    ).toBe('code')
  })

  it('returns null for unmatched files', () => {
    expect(
      matchRole({ filePath: '/project/other/file.tree', config }),
    ).toBeNull()
  })

  it('returns null for non-tree files', () => {
    expect(
      matchRole({ filePath: '/project/code/readme.md', config }),
    ).toBeNull()
  })
})

describe('matchRole edge cases', () => {
  it('handles single role with no miss', () => {
    const config = parseRoleFile({
      text: `
role code
  take @/code/**/*.tree
`,
      root: '/app',
    })

    expect(
      matchRole({ filePath: '/app/code/main.tree', config }),
    ).toBe('code')
    expect(
      matchRole({ filePath: '/app/book/main.tree', config }),
    ).toBeNull()
  })

  it('first matching role wins', () => {
    const config = parseRoleFile({
      text: `
role special
  take @/code/special/**/*.tree

role code
  take @/code/**/*.tree
`,
      root: '/app',
    })

    expect(
      matchRole({ filePath: '/app/code/special/foo.tree', config }),
    ).toBe('special')
    expect(
      matchRole({ filePath: '/app/code/normal.tree', config }),
    ).toBe('code')
  })

  // The package's OWN role.tree, read from disk. It answered null for every
  // file until 2026-08-29, because it was written with `bind` and `~/` while
  // this reader takes `take` and `@/`. Two spellings of one grammar, and the
  // disagreement was silent. This asserts the file the reader actually reads.
  it('the @term/term role file resolves real paths', () => {
    const root = join(__dirname, '..', '..', '..')
    const config = parseRoleFile({
      text: readFileSync(join(root, 'base', 'role.tree'), 'utf8'),
      root,
    })

    expect(config.rules.map(rule => rule.name)).toEqual(['book', 'code'])
    expect(config.rules.every(rule => rule.take.length > 0)).toBe(true)

    const roleOf = (path: string) =>
      matchRole({ filePath: join(root, path), config })

    expect(roleOf('book/cli/base.tree')).toBe('book')
    expect(roleOf('book/cli/code/example.tree')).toBe('code')
    expect(roleOf('book/web/view/example.tree')).toBe('code')
    expect(roleOf('code/a/b.tree')).toBe('code')
    expect(roleOf('deck/make/code/x.tree')).toBe(null)
  })
})

// THE LEAN MARK. Scoping lean to a subtree depends on `matchRoleRule` returning the FIRST matching rule, and
// on one role name being allowed to appear twice with different marks. That is how the reader behaves and
// nothing asserted it, so a later rewrite that sorted or merged the rules would change what a file MEANS with
// no test failing. lean-0010.
describe('the lean mark', () => {
  const CONFIG = `
role code
  mark lean
  take @/code/grammar/**/*.tree

role code
  take @/code/**/*.tree

role book
  take @/book/**/*.tree
`

  const config = parseRoleFile({ text: CONFIG, root: '/project' })

  const ruleFor = (path: string) =>
    matchRoleRule({ filePath: `/project${path}`, config })

  it('carries the mark on the rule that declares it', () => {
    expect(ruleFor('/code/grammar/sound.tree')?.mark).toContain('lean')
  })

  it('leaves a rule that does not declare it unmarked', () => {
    const rule = ruleFor('/code/other/thing.tree')

    expect(rule?.name).toBe('code')
    expect(rule?.mark ?? []).not.toContain('lean')
  })

  it('a rule with no mark at all carries an empty list, never undefined', () => {
    expect(ruleFor('/book/page.tree')?.mark).toEqual([])
  })

  // WRITTEN ORDER IS THE PRECEDENCE. Both rules are called `code` and both match the grammar file; the
  // narrower one is written first, so it wins and the file is lean. Sorting or merging the rules would
  // silently take the mark away.
  it('the narrower rule written first wins, so both spellings keep one role name', () => {
    expect(ruleFor('/code/grammar/sound.tree')?.name).toBe('code')
    expect(ruleFor('/code/other/thing.tree')?.name).toBe('code')
    expect(ruleFor('/code/grammar/sound.tree')).not.toBe(
      ruleFor('/code/other/thing.tree'),
    )
  })

  it('and the broad rule written first takes the mark away from the whole role', () => {
    const flipped = parseRoleFile({
      text: `
role code
  take @/code/**/*.tree

role code
  mark lean
  take @/code/grammar/**/*.tree
`,
      root: '/project',
    })

    expect(
      matchRoleRule({
        filePath: '/project/code/grammar/sound.tree',
        config: flipped,
      })?.mark ?? [],
    ).not.toContain('lean')
  })
})

// THE MILL ROLE IS NOT LEAN, and this is the gate that says so. A `mint` file carries
// `hook make / make x / bind a, read a`, which HAS a bind site, so a lean pass would fire there the moment a
// glob let it. It must not: a grammar file is the one place where the heads ARE the vocabulary under
// discussion, and a file describing how heads are read must not be read by a rule that rewrites heads.
// lean-0026.
// THE MILL ROLE IS NOT LEAN, and this is the gate that says so. A `mint` file carries
// `hook make / make x / bind a, read a`, which HAS a bind site, so a lean pass would fire there the moment a
// glob let it. It must not: a grammar file is the one place where the heads ARE the vocabulary under
// discussion, and a file describing how heads are read must not be read by a rule that rewrites heads.
// lean-0026.
describe('the mill role stays out of lean', () => {
  const TERM = join(__dirname, '..', '..', '..')

  // one real mill grammar file, as the thing no lean glob may reach
  const MILL = join(TERM, 'deck/mill/code/code/call/mine.tree')

  // every lean `take` glob in a config that matches the mill file
  function leanReaching(text: string, root: string): string[] {
    const config = parseRoleFile({ text, root })

    return config.rules
      .filter(rule => rule.mark.includes('lean'))
      .flatMap(rule => rule.take)
      .filter(entry => globMatch({ pattern: entry.pattern, path: MILL }))
      .map(entry => entry.pattern)
  }

  // the mill file has to EXIST, or every assertion below passes by matching nothing
  it('the mill grammar this gate is written against is on disk', () => {
    expect(existsSync(MILL)).toBe(true)
  })

  // AND THE DETECTOR HAS TO FIRE. Without this the sweep passes while nobody marks lean at all, which is the
  // shape of gate that stops asking without saying so.
  it('catches a lean rule whose glob reaches the mill grammar', () => {
    expect(
      leanReaching(
        `
role code
  mark lean
  take @/deck/mill/code/**/*.tree
`,
        TERM,
      ),
    ).toHaveLength(1)
  })

  it('and says nothing about the same glob without the mark', () => {
    expect(
      leanReaching(
        `
role code
  take @/deck/mill/code/**/*.tree
`,
        TERM,
      ),
    ).toEqual([])
  })

  it('no role.tree in the tree marks lean over a mill grammar path', () => {
    const roots = readdirSync(join(TERM, 'deck'))
      .map(name => join(TERM, 'deck', name))
      .filter(dir => existsSync(join(dir, 'base', 'role.tree')))
      .concat(TERM)

    expect(roots.length).toBeGreaterThan(1)

    const offenders = roots.flatMap(root =>
      leanReaching(
        readFileSync(join(root, 'base', 'role.tree'), 'utf8'),
        root,
      ).map(pattern => `${root}: ${pattern}`),
    )

    expect(offenders).toEqual([])
  })

  // `@term/mill` declares no role file of its own, so nothing there can be marked. That is the state this
  // gate protects; a role.tree appearing in that package is the moment to read it.
  it('deck/mill declares no role file of its own', () => {
    expect(existsSync(join(TERM, 'deck', 'mill', 'base', 'role.tree'))).toBe(
      false,
    )
  })
})
