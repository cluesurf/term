// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/audit.ts had, with
// their shapes, answered by deck/deck/code/package/advisory-audit.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
import type { FetchConfig } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/advisory-audit'
import { GRAMMARS, refused } from './grammars'

export type Advisory = { name: string; version: string; severity: string; title: string; url: string; vulnerableRange: string }
export type AuditResult = { advisories: Advisory[]; bySeverity: Record<string, number>; packageCount: number; available: boolean }

export async function auditDependencies(input: { root: string; config?: FetchConfig }): Promise<AuditResult> {
  const config = input.config
    ? { form: 'some', value: { ...input.config, scopeRegistries: new Map(Object.entries(input.config.scopeRegistries ?? {})) } }
    : { form: 'none' }
  const result = (await refused(() => port.auditDependencies(input.root, config as never, GRAMMARS))) as AuditResult & { bySeverity: Map<string, number> }

  return { ...result, bySeverity: Object.fromEntries(result.bySeverity) }
}
