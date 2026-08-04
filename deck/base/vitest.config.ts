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
    },
  },
})
