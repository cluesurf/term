// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/role.ts had, with
// their shapes, answered by deck/deck/code/package/role-reading.tree. The logic is Term; this file only converts shapes for TypeScript callers.
import type { RoleConfig, RoleRule } from '@term/deck/code/form'
import * as port from '@term/deck/code/package/role-reading'
import { GRAMMARS, refusedNow } from './grammars'


const nullable = <T>(value: { form: string; value?: T }): T | null => (value.form === 'some' ? (value.value as T) : null)

export function parseRoleFile(input: { text: string; root: string }): RoleConfig {
  return refusedNow(() => port.parseRoleFile(input.text, input.root, GRAMMARS)) as never
}

export function parseRoleFileByHand(input: { text: string; root: string }): RoleConfig {
  return refusedNow(() => port.parseRoleFileByHand(input.text, input.root)) as never
}

export function matchRole(input: { filePath: string; config: RoleConfig }): string | null {
  return nullable(port.matchRole(input.filePath, input.config as never) as never)
}

export function matchRoleRule(input: { filePath: string; config: RoleConfig }): RoleRule | null {
  return nullable(port.matchRoleRule(input.filePath, input.config as never) as never)
}

export function globMatch(input: { pattern: string; path: string }): boolean {
  return port.globMatch(input.pattern, input.path)
}
