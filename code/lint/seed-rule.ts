// Load lint rules authored in Seed. A rule is an ordinary `.tree` module exporting `task rule` that returns a `rule`
// meta object (name, code, note, spot). This adapter compiles the rule with the real toolchain, imports it, and wraps
// its `spot` in the engine's `Rule` interface, so a Seed-authored rule runs alongside the built-in TypeScript rules
// with no edit to the driver. This is the plugin loader: drop a `.tree` file in the rules directory and it is picked
// up. See note/library/seed/lint-plugins.md.

import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@/code/compile/compile'
import { nativePrelude } from '@/code/compile/native'
import type { Resolver } from '@/code/compile/load'
import type { Span } from '@/code/parser/diagnostic'
import type { Rule, LintContext, LintNode } from '@/code/lint/rule'

// the meta object a Seed rule module exports: the shape of `make rule` in code/rule.tree
type SeedRule = {
  name: string
  code: string
  note: string
  spot: (
    node: unknown,
    tell: (message: string, span: Span) => void,
  ) => void
}

// compile a `.tree` rule, import it, and adapt its `rule` meta to the engine's Rule. `resolve` supplies the stdlib
// (so the rule can `load @cluesurf/base/code/rule`); `readRuntime` supplies any native shim a rule docks.
export async function loadSeedRule(
  source: { file: string; text: string },
  resolve: Resolver,
  readRuntime: (path: string) => string | undefined,
): Promise<Rule> {
  const result = compile(source, { resolve })
  if (!result.ok) {
    const messages = result.diagnostics.map(d => d.message).join('; ')
    throw new Error(`rule ${source.file} did not compile: ${messages}`)
  }
  const prelude = nativePrelude(result.program, 'node', readRuntime)
  const js = transformSync(`${prelude}\n${result.typescript}`, {
    loader: 'ts',
    format: 'esm',
  }).code
  const dir = mkdtempSync(join(tmpdir(), 'seed-rule-'))
  const out = join(dir, 'rule.mjs')
  writeFileSync(out, js)
  const mod = (await import(pathToFileURL(out).href)) as {
    rule: () => SeedRule
  }
  const meta = mod.rule()
  return {
    name: meta.name,
    code: meta.code,
    severity: 'warning',
    docs: meta.note,
    fixable: false,
    check(target: LintNode, context: LintContext): void {
      meta.spot(target.node, (message, span) =>
        context.report({ message, span }),
      )
    },
  }
}

// load every `.tree` rule in a directory, in name order. This is the plugin directory: a rule is added by dropping a
// file here, never by editing the engine. A rule that fails to compile is surfaced, not silently skipped.
export async function loadSeedRules(
  dir: string,
  resolve: Resolver,
  readRuntime: (path: string) => string | undefined,
): Promise<Array<Rule>> {
  const files = readdirSync(dir)
    .filter(name => name.endsWith('.tree'))
    .sort()
  const rules: Array<Rule> = []
  for (const name of files) {
    const file = join(dir, name)
    rules.push(
      await loadSeedRule(
        { file, text: readFileSync(file, 'utf8') },
        resolve,
        readRuntime,
      ),
    )
  }
  return rules
}
