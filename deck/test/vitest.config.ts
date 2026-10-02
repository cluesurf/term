import { existsSync } from 'fs'
import { defineConfig } from 'vitest/config'
import path from 'path'

// @term/test's own vitest suite. The sources import their siblings through the tsconfig path aliases, which vitest
// does not read. Those aliases have TWO candidates each, `deck/<name>/<rest>` and then
// `deck/<name>/host/port/<rest>` (where a module ported to `.tree` is emitted as TypeScript), so a plain alias
// cannot express them. This resolves the same way tsconfig does.
const DECK = path.resolve(__dirname, '..')

function candidates(base: string): string[] {
  return [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), base]
}

export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    {
      name: 'term-paths',
      enforce: 'pre',
      resolveId(id) {
        const m = /^@term\/(make|call|scan|test|flow)\/(.+)$/.exec(id)
        if (!m) return null
        const [, name, rest] = m
        for (const base of [path.join(DECK, name!, rest!), path.join(DECK, name!, 'host/port', rest!)]) {
          for (const file of candidates(base)) {
            if (existsSync(file) && !file.endsWith('/')) {
              if (file === base && !/\.[a-z]+$/.test(base)) continue
              return file
            }
          }
        }
        return null
      },
    },
  ],
})
