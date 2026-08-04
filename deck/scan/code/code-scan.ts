// Run the static rules over a set of `.tree` files: parse and mill each file to the typed AST, then apply every
// rule. A file that fails to parse or mill is skipped (the scanner is not a type checker; `term scan` is), so a
// syntactically broken file never crashes the security scan. This is the code-scanning half of a full scan.

import fsp from 'fs/promises'
import path from 'path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import type { CodeFinding } from './form'
import type { Rule } from './rule'
import { runRules } from './rule'
import { nativeDangerRule } from './rule/native-danger'
import { taintRule } from './rule/taint'

// the built-in rule set. Extend by passing your own rules to `scanCode`.
export const defaultRules: Rule[] = [nativeDangerRule, taintRule]

export type CodeScan = {
  findings: CodeFinding[]
  fileCount: number
  // files that could not be parsed / milled, skipped rather than failing the scan
  skipped: string[]
}

// scan a list of `.tree` files with the given rules (default: the built-in set).
export async function scanFiles(input: {
  files: string[]
  rules?: Rule[]
}): Promise<CodeScan> {
  const rules = input.rules ?? defaultRules
  const findings: CodeFinding[] = []
  const skipped: string[] = []

  for (const file of input.files) {
    let text: string

    try {
      text = await fsp.readFile(file, 'utf-8')
    } catch {
      skipped.push(file)
      continue
    }

    const parsed = parse({ file, text })

    if (!parsed.ok) {
      skipped.push(file)
      continue
    }

    const milled = mill(parsed.tree, file)

    if (!milled.ok) {
      skipped.push(file)
      continue
    }

    findings.push(...runRules(milled.program, file, rules))
  }

  return { findings, fileCount: input.files.length, skipped }
}

// every `.tree` file under a directory, skipping generated output and dependency / vcs folders (the same skip set
// the compiler's project walker uses).
export async function findTreeFiles(
  dir: string,
  out: string[] = [],
): Promise<string[]> {
  let entries: string[]

  try {
    entries = await fsp.readdir(dir)
  } catch {
    return out
  }

  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'host' || entry === '.git') {
      continue
    }

    const full = path.join(dir, entry)
    const stat = await fsp.stat(full)

    if (stat.isDirectory()) {
      await findTreeFiles(full, out)
    } else if (entry.endsWith('.tree')) {
      out.push(full)
    }
  }

  return out
}

// scan an entire project directory's `.tree` sources.
export async function scanProject(input: {
  root: string
  rules?: Rule[]
}): Promise<CodeScan> {
  const files = await findTreeFiles(input.root)

  return scanFiles({ files, rules: input.rules })
}
