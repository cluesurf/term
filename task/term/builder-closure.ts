// `pnpm term:builder-closure [--inside]`: which deck/make/code modules the port builder loads.
//
// task/port-build.ts compiles every port with the WORKING TREE's compiler, and that compiler imports its own ports
// from deck/make/host/port/, which .gitignore excludes. So a port of a module the builder loads makes a fresh clone
// unable to build, until the builder emits with a pinned stage0 (self-hosting-0034). A port of anything else does not.
// This is the list that tells them apart, read off an esbuild metafile of task/port-build.ts, so it is the real
// closure and not a guess from imports.
//
// It prints the modules OUTSIDE the closure, which are the ones safe to port before 0034, each marked `port` when a
// `.tree` port already sits beside it or replaced it. `--inside` prints the closure instead.
//
// Every file in the closure must parse, or esbuild fails and names the file: an uncommitted half-edit in another
// session's file stops it, which is what that error means.
//
// Run from the repository root: pnpm term:builder-closure

import { build } from 'esbuild'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const inside = process.argv.includes('--inside')
const code = 'deck/make/code'

// the root task/ folder runs as CommonJS, which has no top-level await
void report()

async function report(): Promise<void> {
const result = await build({
  entryPoints: ['task/port-build.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  write: false,
  metafile: true,
  logLevel: 'silent',
  tsconfig: 'tsconfig.json',
})

// a path the bundle read, as a module path under code/: a port read from host/port/ counts as its module
const loaded = new Set(
  Object.keys(result.metafile.inputs)
    .map(path => path.replace(/^deck\/make\/host\/port\/code\//, `${code}/`))
    .filter(path => path.startsWith(`${code}/`))
    .map(path => path.slice(code.length + 1).replace(/\.tree$|\.ts$/, '')),
)

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      walk(path, out)
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts')) {
      out.push(relative(code, path).replace(/\.ts$/, ''))
    }
  }

  return out
}

const all = walk(code)
const shown = all.filter(path => loaded.has(path) === inside).sort()
const ported = (path: string): boolean => existsSync(join(code, `${path}.tree`))

console.log(`the builder loads ${all.filter(path => loaded.has(path)).length} of ${all.length} ${code} .ts files`)
console.log(`${inside ? 'inside' : 'outside'} the builder (${shown.length}):`)

for (const path of shown) {
  console.log(`  ${path}.ts${ported(path) ? '  port' : ''}`)
}
}
