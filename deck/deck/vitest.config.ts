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
      // the manifest and lockfile are parsed with the real tree parser, so this package
      // resolves its sibling compiler exactly as the parent tsconfig does. There is no
      // cycle: the compiler does not import the package manager.
      '@term/make': path.resolve(__dirname, '../make'),
      // the package manager is built ON @cluesurf/save: content addressing, the prolly
      // tree, chunk / object / ref stores, commits, sync. It used to reimplement all
      // of that in code/object/. save lives in mesh/deck/save, outside this repository,
      // and is resolved from its source here until @term/deck takes it from npm.
      '@cluesurf/save': path.resolve(__dirname, '../../../../../../mesh/deck/save/code'),
    },
  },
})
