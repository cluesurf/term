import type { RecordNode, Value } from '@term/base/code/base/type'
import { isMark } from '@term/base/code/base/mark'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'
import type { Dataset } from '@term/base/code/diff/change'
import type { Constraint, Form, Property, RoleBase, Severity } from '@term/base/code/form/form'

// Validation runs the built-in checks and the form constraints. A `hold` violation
// is an error (blocks a commit); a `want` violation is a warning. Validation is a
// pure function of the record graph and the forms, so any implementation agrees.
//
// See note/library/base/06-schema-and-validation.md.

export type Diagnostic = {
  severity: Severity
  mark: string | undefined
  field: string | undefined
  message: string
}

// A linear-time subset of patterns for `face`: anchored, no backtracking risk in
// practice for the small alternations and character classes used by schemas. The
// pattern is compiled once and matched fully.
function matchFace(pattern: string, value: string): boolean {
  const re = new RegExp(`^(?:${pattern})$`, 'u')
  return re.test(value)
}

function baseKindMatches(base: string, value: Value): boolean {
  switch (base) {
    case 'text':
      return value.kind === 'text'
    case 'integer':
      return value.kind === 'integer'
    case 'decimal':
      return value.kind === 'decimal'
    case 'boolean':
      return value.kind === 'boolean'
    case 'date':
      return value.kind === 'date'
    case 'uuid':
      return value.kind === 'text' && isMark(value.value)
    default:
      return false
  }
}

function spanValue(value: Value): number | undefined {
  switch (value.kind) {
    case 'integer':
      return Number(value.value)
    case 'decimal':
      return Number(value.value)
    case 'text':
      return [...value.value].length
    default:
      return undefined
  }
}

// Check one constraint against one value.
function checkConstraint(
  c: Constraint,
  value: Value,
  ctx: { dataset?: Dataset },
): string | undefined {
  switch (c.kind) {
    case 'need':
      return value.kind === 'null' ? 'value is required' : undefined
    case 'span': {
      const n = spanValue(value)
      if (n === undefined) {
        return undefined
      }
      if (c.min !== undefined && n < c.min) {
        return `below minimum ${c.min}`
      }
      if (c.max !== undefined && n > c.max) {
        return `above maximum ${c.max}`
      }
      return undefined
    }
    case 'face':
      if (value.kind !== 'text') {
        return undefined
      }
      return matchFace(c.pattern, value.value)
        ? undefined
        : `does not match pattern ${c.pattern}`
    case 'pick': {
      const v = value.kind === 'text' ? value.value : canonicalizeValue(value)
      return c.options.includes(v)
        ? undefined
        : `not one of ${c.options.join(', ')}`
    }
    case 'sole':
    case 'sort':
    case 'mark':
    case 'seal':
      // handled at the record/collection or dataset level, not per-value here
      return undefined
    default:
      return undefined
  }
}

function checkProperty(
  node: RecordNode,
  p: Property,
  ctx: { dataset?: Dataset; role?: RoleBase },
): Array<Diagnostic> {
  const out: Array<Diagnostic> = []
  const value = node.fields.get(p.name)

  // presence
  const needs = p.constraints.filter(c => c.kind === 'need')
  if (value === undefined) {
    for (const c of needs) {
      out.push({
        severity: c.severity,
        mark: node.mark,
        field: p.name,
        message: 'missing required property',
      })
    }
    return out
  }

  // type conformance for scalar/ref
  if ('base' in p.like && !p.collection) {
    if (value.kind !== 'null' && !baseKindMatches(p.like.base, value)) {
      out.push({
        severity: 'hold',
        mark: node.mark,
        field: p.name,
        message: `expected ${p.like.base}, got ${value.kind}`,
      })
    }
  }
  if ('ref' in p.like && !p.collection && value.kind === 'ref' && ctx.dataset) {
    if (!ctx.dataset.has(value.target)) {
      out.push({
        severity: 'hold',
        mark: node.mark,
        field: p.name,
        message: `reference ${value.target} does not resolve`,
      })
    }
  }

  // collection-level constraints (mark, sort)
  if (p.collection && value.kind === 'collection') {
    const wantMark = p.constraints.some(c => c.kind === 'mark')
    if (wantMark) {
      for (const it of value.items) {
        if (it.mark === undefined || !isMark(it.mark)) {
          out.push({
            severity: 'hold',
            mark: node.mark,
            field: p.name,
            message: 'collection member is not marked',
          })
          break
        }
      }
    }
  }

  // per-value constraints
  for (const c of p.constraints) {
    const message = checkConstraint(c, value, ctx)
    if (message) {
      out.push({ severity: c.severity, mark: node.mark, field: p.name, message })
    }
  }

  // recurse into nested records and record collections, validating each against
  // its declared form
  if ('record' in p.like && ctx.role) {
    const nestedForm = ctx.role.forms.get(p.like.record)
    if (nestedForm) {
      const nestedCtx = { dataset: ctx.dataset, role: ctx.role }
      if (!p.collection && value.kind === 'record') {
        out.push(...validateRecord(value.record, nestedForm, nestedCtx))
      } else if (p.collection && value.kind === 'collection') {
        for (const it of value.items) {
          if (it.value.kind === 'record') {
            out.push(...validateRecord(it.value.record, nestedForm, nestedCtx))
          }
        }
      }
    }
  }

  return out
}

// Validate one record against its form.
export function validateRecord(
  node: RecordNode,
  form: Form,
  ctx: { dataset?: Dataset; isBaseForm?: boolean; role?: RoleBase } = {},
): Array<Diagnostic> {
  const out: Array<Diagnostic> = []

  // the mark lint rule: an instance of a base form must carry a mark
  if (ctx.isBaseForm && (node.mark === undefined || !isMark(node.mark))) {
    out.push({
      severity: 'hold',
      mark: node.mark,
      field: undefined,
      message: 'instance of a base form must have a mark',
    })
  }

  for (const p of form.properties) {
    out.push(...checkProperty(node, p, ctx))
  }
  return out
}

// Validate a whole dataset against a role-base registration, including uniqueness
// (`sole`) across the dataset.
export function validateDataset(
  dataset: Dataset,
  role: RoleBase,
): Array<Diagnostic> {
  const out: Array<Diagnostic> = []
  const seen = new Map<string, Set<string>>() // form.field -> canonical values

  for (const node of dataset.values()) {
    const form = role.forms.get(node.type)
    if (!form) {
      out.push({
        severity: 'hold',
        mark: node.mark,
        field: undefined,
        message: `no base form for type ${node.type}`,
      })
      continue
    }
    out.push(...validateRecord(node, form, { dataset, isBaseForm: true, role }))

    // sole (uniqueness) across the dataset
    for (const p of form.properties) {
      const soleC = p.constraints.find(c => c.kind === 'sole')
      if (!soleC) {
        continue
      }
      const value = node.fields.get(p.name)
      if (!value) {
        continue
      }
      const key = `${node.type}.${p.name}`
      const canon = canonicalizeValue(value)
      const set = seen.get(key) ?? new Set<string>()
      if (set.has(canon)) {
        out.push({
          severity: soleC.severity,
          mark: node.mark,
          field: p.name,
          message: 'duplicate value violates uniqueness',
        })
      }
      set.add(canon)
      seen.set(key, set)
    }
  }
  return out
}

// The errors (hold-severity diagnostics) that block a commit.
export function errors(diags: Array<Diagnostic>): Array<Diagnostic> {
  return diags.filter(d => d.severity === 'hold')
}
