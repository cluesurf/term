// The CLI bundles hold no import of a `@term/*` module: `pnpm run make:line` ends with it.
//
// The bundles are built with `--packages=external`, so a bare import that does not resolve through the tsconfig's
// paths is left as an import, and nothing fails until the CLI starts: node finds no package `@term/make` and every
// `term` command dies before it runs. That happened on 2026-10-06, when a file under deck/flow (which has a tsconfig of
// its own, with no paths) was first reached from the CLI. Every bundle is read here, and one such import fails the
// build naming its line, so the hazard shows at build time instead of at the next command.

import { readFileSync } from 'node:fs'

const bundles = ['host/line.js', 'host/dock.mjs', 'host/need.mjs', 'host/need-hand.mjs']
const found: string[] = []

for (const bundle of bundles) {
  readFileSync(bundle, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (/^import .* from "@term\//.test(line)) {
        found.push(`${bundle}:${index + 1}  ${line}`)
      }
    })
}

if (found.length > 0) {
  console.log(`line-imports: ${found.length} import${found.length === 1 ? '' : 's'} of a @term module left in a bundle, which the CLI cannot load:\n  ${found.join('\n  ')}`)
  process.exit(1)
}

console.log(`line-imports: ${bundles.length} bundles, no @term import left`)
