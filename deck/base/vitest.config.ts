import { defineConfig } from 'vitest/config'
import path from 'path'

// Per-package vitest config: tests live in test/ and import library code through the
// `@` alias, which maps to code/, matching the tsconfig path alias.
export default defineConfig({
  test: {
    globals: false,
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './code'),
      // base refers to its own modules by the SAME name other packages use, so it is
      // importable from outside. A bare `@/` alias only ever resolves against the
      // importing project, which made base unusable as a dependency.
      '@term/base': path.resolve(__dirname, '.'),
    },
  },
})
