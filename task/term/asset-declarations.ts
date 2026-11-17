// The asset declarations of @term/site as JSON, written beside its assets.json.
//
// deck/site/code/base/asset/declarations.tree holds the @font-face declarations and the no-hash paths that an asset
// sync reads. A sync written in another language cannot load a .tree, and the TypeScript `term make` emits for it sits
// in host/, which is build output and never committed. So this tool reads that compiled module (never the .tree
// itself: one parser reads .tree) and writes the same data as declarations.json beside assets.json, deterministic and
// sorted, so a sync reads one committed data file.
//
// Build the package first, so host/ is current: `term make` in deck/site.
//
//   node --experimental-strip-types task/term/asset-declarations.ts            report: exit 1 when the file is stale
//   node --experimental-strip-types task/term/asset-declarations.ts --commit   write it

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TERM_ROOT } from './root.ts'

// TERM_ASSET_DECLARATIONS_SITE names another site folder, so a test can run the tool on a scratch copy
const SITE = process.env.TERM_ASSET_DECLARATIONS_SITE ?? join(TERM_ROOT, 'deck', 'site')
const COMPILED = join(SITE, 'host', '.unit', '_term_site_code_base_asset_declarations.ts')
const OUTPUT = join(SITE, 'code', 'base', 'asset', 'declarations.json')

// a variant of a form with no fields, as the compiler emits it: `{ form: "opentype" }`
type Variant = { form: string }

type CompiledDeclaration = {
  form: string
  asset: string
  fontFamily: string
  format: Variant
  fontDisplay: Variant
  fontWeight?: string
  fontStyle?: string
}

// the JSON shape: snake_case fields, a variant written as its case name, an absent field left out
type FontFaceEntry = {
  form: 'font-face'
  asset: string
  font_family: string
  format: string
  font_display: string
  font_weight?: string
  font_style?: string
}

type DeclarationsFile = {
  version: 1
  asset_declarations: FontFaceEntry[]
  no_hash_paths: string[]
}

function toEntry(declaration: CompiledDeclaration): FontFaceEntry {
  if (declaration.form !== 'font-face') {
    throw new Error(`asset-declarations: no JSON shape for the declaration form ${declaration.form}`)
  }
  const entry: FontFaceEntry = {
    form: 'font-face',
    asset: declaration.asset,
    font_family: declaration.fontFamily,
    format: declaration.format.form,
    font_display: declaration.fontDisplay.form,
  }
  if (declaration.fontWeight !== undefined) entry.font_weight = declaration.fontWeight
  if (declaration.fontStyle !== undefined) entry.font_style = declaration.fontStyle
  return entry
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

async function render(): Promise<string> {
  if (!existsSync(COMPILED)) {
    console.error(`asset-declarations: ${relative(TERM_ROOT, COMPILED)} is missing: run \`term make\` in deck/site`)
    process.exit(2)
  }
  // No freshness test by file time: `term make` leaves a unit whose text did not change untouched, so a current unit can
  // be older than its .tree. Build first.
  const compiled = await import(pathToFileURL(COMPILED).href)
  const declarations = (compiled.assetDeclarations() as CompiledDeclaration[])
    .map(toEntry)
    .sort((a, b) => compare(a.asset, b.asset) || compare(a.form, b.form))
  const paths = [...new Set(compiled.noHashPaths() as string[])].sort(compare)
  const file: DeclarationsFile = { version: 1, asset_declarations: declarations, no_hash_paths: paths }
  return JSON.stringify(file, null, 2) + '\n'
}

const commit = process.argv.includes('--commit')
const next = await render()
const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : null
const name = relative(TERM_ROOT, OUTPUT)

if (current === next) {
  console.log(`asset-declarations: ${name} is current`)
} else if (commit) {
  writeFileSync(OUTPUT, next, 'utf8')
  console.log(`asset-declarations: wrote ${name}`)
} else {
  console.log(`asset-declarations: ${name} is ${current === null ? 'missing' : 'stale'} (--commit writes it)`)
  process.exitCode = 1
}
