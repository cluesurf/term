import { describe, it, expect } from 'vitest'
import { parseManifest, writeManifest } from '../code/manifest'

describe('parseManifest', () => {
  it('parses a basic manifest', () => {
    const text = `
deck @cluesurf/my-app
  code <1.0.0>
  head <My cool app>
  mind <Lance Pollard>
  lock apache-2
  term <tool>
  link @cluesurf/base, code <1.x.x>
  link @cluesurf/tree, code <2.1.0>
`
    const manifest = parseManifest({ text })

    expect(manifest.host).toBe('cluesurf')
    expect(manifest.name).toBe('my-app')
    expect(manifest.code).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(manifest.head).toBe('My cool app')
    expect(manifest.lock).toBe('apache-2')
    expect(manifest.term).toEqual(['tool'])
    expect(manifest.mind).toEqual([{ name: 'Lance Pollard' }])
    expect(manifest.link).toHaveLength(2)
    expect(manifest.link[0]!.name).toBe('@cluesurf/base')
    expect(manifest.link[0]!.code).toEqual({
      form: 'wild',
      major: 1,
    })
    expect(manifest.link[1]!.name).toBe('@cluesurf/tree')
    expect(manifest.link[1]!.code).toEqual({
      form: 'exact',
      code: { major: 2, minor: 1, patch: 0 },
    })
  })

  it('parses peer dependencies', () => {
    const text = `
deck @cluesurf/plugin
  code <0.1.0>
  link @cluesurf/core, code <1.x.x>, have 1
`
    const manifest = parseManifest({ text })
    expect(manifest.link[0]!.have).toBe(1)
  })

  it('parses hooks', () => {
    const text = `
deck @cluesurf/tool
  code <1.0.0>
  hook build, task ./task/build
`
    const manifest = parseManifest({ text })
    expect(manifest.hook).toEqual({ build: './task/build' })
  })

  it('parses role directive', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
  role ./base/role
`
    const manifest = parseManifest({ text })
    expect(manifest.role).toBe('./base/role')
  })

  it('parses directory pointers', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
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
  code <0.0.1>
  hide true
`
    const manifest = parseManifest({ text })
    expect(manifest.hide).toBe(true)
  })

  it('parses site and view', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
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
  code <0.0.1>
  deck ./deck/load
  deck ./deck/line
`
    const manifest = parseManifest({ text })
    expect(manifest.deck).toEqual(['./deck/load', './deck/line'])
  })

  it('parses mind with inline base', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
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
  code <0.0.1>
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
  code <0.0.1>
  link @cluesurf/base, code <0.0.x>

  case work
    link @cluesurf/buzz, code <0.0.x>
    link @cluesurf/crow, code <0.0.x>
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
  code <0.0.1>

  host <https://npm.pkg.github.com>
    link @cluesurf/seal, code <0.0.x>
    link @cluesurf/cone, code <0.0.x>
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
  code <0.0.1>
  sort tool
  lock apache-2
  site <https://github.com/cluesurf/base>
  view ./view/tree.gif
  hide true

  term tree-code
  term compiler

  deck ./deck/load
  deck ./deck/call

  link @cluesurf/bind, code <0.0.x>
  link @cluesurf/moon, code <0.0.x>

  host <https://npm.pkg.github.com>
    link @cluesurf/seal, code <0.0.x>

  case work
    link @cluesurf/buzz, code <0.0.x>

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
  code <1.0.0>
  head <My cool app>
  link @cluesurf/base, code <1.x.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('deck @cluesurf/my-app')
    expect(output).toContain('code <1.0.0>')
    expect(output).toContain('head <My cool app>')
    expect(output).toContain('link @cluesurf/base, code <1.x.x>')
  })

  it('writes new fields', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
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
  code <0.0.1>
  case work
    link @cluesurf/buzz, code <0.0.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('case work')
    expect(output).toContain('    link @cluesurf/buzz')
  })

  it('writes host block', () => {
    const text = `
deck @cluesurf/base
  code <0.0.1>
  host <https://npm.pkg.github.com>
    link @cluesurf/seal, code <0.0.x>
`
    const manifest = parseManifest({ text })
    const output = writeManifest({ manifest })

    expect(output).toContain('host <https://npm.pkg.github.com>')
    expect(output).toContain('    link @cluesurf/seal')
  })
})
