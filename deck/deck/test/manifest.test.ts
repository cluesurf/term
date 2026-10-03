import { describe, it, expect } from 'vitest'
import {
  manifestSpellings,
  parseManifest,
  rewriteManifestSpellings,
  writeManifest,
} from '../code/manifest'

describe('parseManifest', () => {
  it('parses a basic manifest', () => {
    const text = `
deck @cluesurf/my-app
  mark <1.0.0>
  head <My cool app>
  mind <Lance Pollard>
  lock apache-2
  term <tool>
  link @cluesurf/base, mark <1.x.x>
  link @cluesurf/tree, mark <2.1.0>
`
    const manifest = parseManifest({ text })

    expect(manifest.host).toBe('cluesurf')
    expect(manifest.name).toBe('my-app')
    expect(manifest.mark).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(manifest.code).toBeUndefined()
    expect(manifest.head).toBe('My cool app')
    expect(manifest.lock).toBe('apache-2')
    expect(manifest.term).toEqual(['tool'])
    expect(manifest.mind).toEqual([{ name: 'Lance Pollard' }])
    expect(manifest.link).toHaveLength(2)
    expect(manifest.link[0]!.name).toBe('@cluesurf/base')
    expect(manifest.link[0]!.mark).toEqual({
      form: 'wild',
      major: 1,
    })
    expect(manifest.link[1]!.name).toBe('@cluesurf/tree')
    expect(manifest.link[1]!.mark).toEqual({
      form: 'exact',
      code: { major: 2, minor: 1, patch: 0 },
    })
  })

  // the old spelling still reads: a text literal under `code` is the version, never a folder
  it('reads the old `code <version>` spelling, on the manifest and on a link', () => {
    const text = `
deck @cluesurf/old
  code <1.4.2>
  bear ./code
  link @cluesurf/base, code <1.x.x>
`
    const manifest = parseManifest({ text })

    expect(manifest.mark).toEqual({ major: 1, minor: 4, patch: 2 })
    expect(manifest.code).toBe('./code')
    expect(manifest.link[0]!.mark).toEqual({ form: 'wild', major: 1 })
  })

  it('reads `mark` as the version and `code ./src` as the code root', () => {
    const text = `
deck @alice/tools
  head <Small tools for Alice>
  mark <1.4.2>
  code ./src
`
    const manifest = parseManifest({ text })

    expect(manifest.mark).toEqual({ major: 1, minor: 4, patch: 2 })
    expect(manifest.code).toBe('./src')
    expect(writeManifest({ manifest })).toContain('  code ./src\n')
    expect(writeManifest({ manifest })).toContain('  mark <1.4.2>\n')
  })

  it('parses peer dependencies', () => {
    const text = `
deck @cluesurf/plugin
  mark <0.1.0>
  link @cluesurf/core, mark(<1.x.x>), have 1
`
    const manifest = parseManifest({ text })
    expect(manifest.link[0]!.have).toBe(1)
  })

  it('writes a peer dependency that reads back as one', () => {
    const text = `
deck @cluesurf/plugin
  mark <0.1.0>
  link @cluesurf/core, mark(<1.x.x>), have 1
`
    const manifest = parseManifest({ text })
    const again = parseManifest({ text: writeManifest({ manifest }) })
    expect(again.link[0]!.have).toBe(1)
    expect(again.link[0]!.name).toBe('@cluesurf/core')
  })

  it('parses hooks', () => {
    const text = `
deck @cluesurf/tool
  mark <1.0.0>
  hook build, task ./task/build
`
    const manifest = parseManifest({ text })
    expect(manifest.hook).toEqual({ build: './task/build' })
  })

  it('parses role directive', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  role ./base/role
`
    const manifest = parseManifest({ text })
    expect(manifest.role).toBe('./base/role')
  })

  it('parses directory pointers', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  task ./task
  book ./book
  role ./base/role
  line ./line
  call ./call
  test ./test
`
    const manifest = parseManifest({ text })
    expect(manifest.task).toBe('./task')
    expect(manifest.book).toBe('./book')
    expect(manifest.role).toBe('./base/role')
    expect(manifest.line).toBe('./line')
    expect(manifest.call).toBe('./call')
    expect(manifest.test).toBe('./test')
  })

  it('parses hide flag', () => {
    const text = `
deck @cluesurf/my-app
  mark <0.0.1>
  hide true
`
    const manifest = parseManifest({ text })
    expect(manifest.hide).toBe(true)
  })

  it('parses site and view', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  site <https://github.com/cluesurf/seed>
  view ./view/tree.gif
`
    const manifest = parseManifest({ text })
    expect(manifest.site).toBe('https://github.com/cluesurf/seed')
    expect(manifest.view).toBe('./view/tree.gif')
  })

  it('parses sub-package deck entries', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  deck ./deck/load
  deck ./deck/line
`
    const manifest = parseManifest({ text })
    expect(manifest.deck).toEqual(['./deck/load', './deck/line'])
  })

  it('parses mind with inline base', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  mind <Lance Pollard>, base <lp@elk.fm>
`
    const manifest = parseManifest({ text })
    expect(manifest.mind).toEqual([
      { name: 'Lance Pollard', base: 'lp@elk.fm' },
    ])
  })

  it('parses mind with child site', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  mind <Lance Pollard>, base <lp@elk.fm>
    site <lancejpollard.com>
`
    const manifest = parseManifest({ text })
    expect(manifest.mind).toEqual([
      { name: 'Lance Pollard', base: 'lp@elk.fm', site: 'lancejpollard.com' },
    ])
  })

  it('parses case work dev dependencies', () => {
    const text = `
deck @cluesurf/my-app
  mark <0.0.1>
  link @cluesurf/base, mark <0.0.x>

  case work
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>
`
    const manifest = parseManifest({ text })
    expect(manifest.link).toHaveLength(1)
    expect(manifest.link[0]!.name).toBe('@cluesurf/base')
    expect(manifest.devLink).toHaveLength(2)
    expect(manifest.devLink![0]!.name).toBe('@cluesurf/buzz')
    expect(manifest.devLink![1]!.name).toBe('@cluesurf/crow')
  })

  it('parses host registry blocks', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>

  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>
    link @cluesurf/cone, mark <0.0.x>
`
    const manifest = parseManifest({ text })
    expect(manifest.hostLink).toHaveLength(1)
    expect(manifest.hostLink![0]!.registry).toBe('https://npm.pkg.github.com')
    expect(manifest.hostLink![0]!.link).toHaveLength(2)
    expect(manifest.hostLink![0]!.link[0]!.name).toBe('@cluesurf/seal')
  })

  it('parses a full manifest', () => {
    const text = `
deck @cluesurf/base
  head <A TreeCode Framework>
  mark <0.0.1>
  sort tool
  lock apache-2
  site <https://github.com/cluesurf/base>
  view ./view/tree.gif
  hide true

  term tree-code
  term compiler

  deck ./deck/load
  deck ./deck/call

  link @cluesurf/bind, mark <0.0.x>
  link @cluesurf/moon, mark <0.0.x>

  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>

  case work
    link @cluesurf/buzz, mark <0.0.x>

  task ./task
  book ./book
  role ./base/role
  call ./call

  mind <Lance Pollard>, base <lp@elk.fm>
    site <lancejpollard.com>
`
    const manifest = parseManifest({ text })

    expect(manifest.host).toBe('cluesurf')
    expect(manifest.name).toBe('base')
    expect(manifest.head).toBe('A TreeCode Framework')
    expect(manifest.sort).toBe('tool')
    expect(manifest.lock).toBe('apache-2')
    expect(manifest.site).toBe('https://github.com/cluesurf/base')
    expect(manifest.view).toBe('./view/tree.gif')
    expect(manifest.hide).toBe(true)
    expect(manifest.term).toEqual(['tree-code', 'compiler'])
    expect(manifest.deck).toEqual(['./deck/load', './deck/call'])
    expect(manifest.link).toHaveLength(2)
    expect(manifest.hostLink).toHaveLength(1)
    expect(manifest.devLink).toHaveLength(1)
    expect(manifest.task).toBe('./task')
    expect(manifest.book).toBe('./book')
    expect(manifest.role).toBe('./base/role')
    expect(manifest.call).toBe('./call')
    expect(manifest.mind).toEqual([
      { name: 'Lance Pollard', base: 'lp@elk.fm', site: 'lancejpollard.com' },
    ])
  })
})

describe('writeManifest', () => {
  it('round-trips a manifest', () => {
    const text = `
deck @cluesurf/my-app
  mark <1.0.0>
  head <My cool app>
  link @cluesurf/base, mark <1.x.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('deck @cluesurf/my-app')
    expect(output).toContain('mark <1.0.0>')
    expect(output).toContain('head <My cool app>')
    expect(output).toContain('link @cluesurf/base, mark <1.x.x>')
    // the default code root is not written
    expect(output).not.toContain('code ')
  })

  it('writes the old spelling back in the new one', () => {
    const manifest = parseManifest({
      text: 'deck @cluesurf/old\n  code <1.0.2>\n  bear ./code\n  link @cluesurf/base, code <0.0.x>\n',
    })

    expect(writeManifest({ manifest })).toBe(
      'deck @cluesurf/old\n  mark <1.0.2>\n  link @cluesurf/base, mark <0.0.x>\n',
    )
  })

  it('writes new fields', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  hide true
  site <https://github.com/cluesurf/seed>
  view ./view/tree.gif
  deck ./deck/load
  role ./base/role
  call ./call
  mind <Lance Pollard>, base <lp@elk.fm>
    site <lancejpollard.com>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('hide true')
    expect(output).toContain('site <https://github.com/cluesurf/seed>')
    expect(output).toContain('view ./view/tree.gif')
    expect(output).toContain('deck ./deck/load')
    expect(output).toContain('role ./base/role')
    expect(output).toContain('call ./call')
    expect(output).toContain('mind <Lance Pollard>, base <lp@elk.fm>')
    expect(output).toContain('site <lancejpollard.com>')
  })

  it('writes case work block', () => {
    const text = `
deck @cluesurf/my-app
  mark <0.0.1>
  case work
    link @cluesurf/buzz, mark <0.0.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('case work')
    expect(output).toContain('    link @cluesurf/buzz')
  })

  it('writes host block', () => {
    const text = `
deck @cluesurf/base
  mark <0.0.1>
  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('host <https://npm.pkg.github.com>')
    expect(output).toContain('    link @cluesurf/seal')
  })
})

// `term lint` reports these and `term lint --fix` applies them (note/term/plan/manifest-mark-and-code-root.md)
describe('manifestSpellings', () => {
  const old = `# a comment that stays
deck @cluesurf/old
  head <Old spelling>
  code <1.4.2>
  bear ./code
  link @cluesurf/base, code <0.0.x>

  case work
    link @cluesurf/buzz, code <0.0.x>
`

  it('names every old spelling, once each, by rule', () => {
    const found = manifestSpellings({ text: old })

    expect(found.map(f => `${f.rule}@${f.line + 1}`)).toEqual([
      'manifest-code-version@4',
      'manifest-bear@5',
      'manifest-code-version@6',
      'manifest-code-version@9',
    ])
  })

  it('rewrites them in place, keeping comments and blank lines', () => {
    const fixed = rewriteManifestSpellings({ text: old })

    expect(fixed.text).toBe(`# a comment that stays
deck @cluesurf/old
  head <Old spelling>
  mark <1.4.2>
  link @cluesurf/base, mark <0.0.x>

  case work
    link @cluesurf/buzz, mark <0.0.x>
`)
    expect(manifestSpellings({ text: fixed.text })).toEqual([])
  })

  it('tells a code root from a version by form', () => {
    expect(manifestSpellings({ text: 'deck @a/b\n  mark <1.0.0>\n  code ./src\n' })).toEqual([])
  })

  it('keeps a non-default `bear` path as `code`', () => {
    const fixed = rewriteManifestSpellings({ text: 'deck @a/b\n  mark <1.0.0>\n  bear ./src\n' })

    expect(fixed.text).toBe('deck @a/b\n  mark <1.0.0>\n  code ./src\n')
  })

  it('leaves a lockfile alone', () => {
    expect(manifestSpellings({ text: 'lock <1>\n\ndeck @a/b\n  code <1.0.0>\n' })).toEqual([])
  })
})
