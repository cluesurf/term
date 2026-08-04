import { describe, it, expect } from 'vitest'
import { parseRoleFile, matchRole } from '../code/role'

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
})
