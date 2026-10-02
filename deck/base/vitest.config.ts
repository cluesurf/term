import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    globals: false,
    include: [
      'test/**/*.test.ts',
      'test/**/*.test.tsx',
      'test/**/*.spec.ts',
      'test/**/*.spec.tsx',
    ],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './code'),
    },
  },
})
