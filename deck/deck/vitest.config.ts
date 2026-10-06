import { defineConfig } from 'vitest/config'
import { existsSync } from 'fs'
import path from 'path'

const MAKE = path.resolve(__dirname, '../make')

// this package's own ports the same way: `@term/deck/code/version` is deck/deck/code/version.tree, built to
// host/port by `task/port-build.ts`, and code/code.ts is its face (self-hosting, 2026-10-05)
// and `@term/call/`'s, whose modules ported to Term (call/code/manifest-read.tree beside its face manifest-name.ts,
// 2026-10-06) are reached the same way by a test that imports the CLI's helpers (test/scaffold.test.ts)
const ROOTS: Record<string, string> = {
  '@term/make/': MAKE,
  '@term/deck/': __dirname,
  '@term/call/': path.resolve(__dirname, '../call'),
}

// `@term/make/<path>` the way the parent tsconfig's `paths` reads it: the TypeScript source under deck/make first,
// else the PORT `make:port` writes to deck/make/host/port for a compiler module written in Term (`hashText` is
// deck/make/code/term/hash.tree, `arm` is deck/make/code/check/arm.tree, since 2026-10-02). A bare alias to ../make
// finds no port, and every test that imports the compiler failed with "Cannot find package".
const makeModules = {
  name: 'term-make-port',
  enforce: 'pre' as const,
  resolveId(id: string) {
    const prefix = Object.keys(ROOTS).find(one => id.startsWith(one))

    if (!prefix) {
      return null
    }

    const root = ROOTS[prefix]!
    const rest = id.slice(prefix.length)

    for (const base of [root, path.join(root, 'host/port')]) {
      for (const file of [`${rest}.ts`, `${rest}.tsx`, path.join(rest, 'index.ts'), rest]) {
        const full = path.join(base, file)

        if (existsSync(full) && /\.tsx?$/.test(full)) {
          return full
        }
      }
    }

    return null
  },
}

export default defineConfig({
  plugins: [makeModules],
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
      // resolves its sibling compiler exactly as the parent tsconfig does. That is the
      // plugin above, not an alias: an alias rewrites the id before any plugin sees it,
      // so it would hide the port fallback. There is no cycle: the compiler does not
      // import the package manager.
      // the package manager is built ON @cluesurf/save: content addressing, the prolly
      // tree, chunk / object / ref stores, commits, sync. It used to reimplement all
      // of that in code/object/. save lives in mesh/deck/save, outside this repository,
      // and is resolved from its source here until @term/deck takes it from npm.
      '@cluesurf/save': path.resolve(__dirname, '../../../../../../mesh/deck/save/code'),
    },
  },
})
