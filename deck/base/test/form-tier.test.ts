// A form's package tier: `definition` records clone with a package, `data` records stay remote and
// are queried. The default is `data`, so bulk data never accidentally travels with an install.

import { describe, it, expect } from 'vitest'
import { form, property, tierOf } from '@term/base/code/form/form'

describe('form tier', () => {
  it('defaults to data', () => {
    const language_string = form('language_string', [
      property('text', { base: 'text' }),
    ])

    expect(language_string.tier).toBeUndefined()
    expect(tierOf(language_string)).toBe('data')
  })

  it('carries an explicit definition tier', () => {
    const role = form('role', [property('name', { base: 'text' })], {
      tier: 'definition',
    })

    expect(role.tier).toBe('definition')
    expect(tierOf(role)).toBe('definition')
  })
})
