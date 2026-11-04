import type { RecordNode, Value } from '@cluesurf/save/base/type'
import { isMark } from '@cluesurf/save/base/mark'
import { canonicalizeValue } from '@cluesurf/save/canon/canonicalize'
import type { Dataset } from '@cluesurf/save/diff/change'
import type { Constraint, Form, Like, Property, RoleBase, Severity } from '@cluesurf/save/form/form'

// Validation runs the built-in checks and the form constraints. A `hold` violation
// is an error (blocks a commit); a `want` violation is a warning. Validation is a
// pure function of the record graph and the forms, so any implementation agrees.
//
// See note/project/base/design/06-schema-and-validation.md.

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

/**
 * Whether a value is of a like's kind. The shape question only: a `ref` that does not
 * resolve and a nested record with a bad field are reported by the checks below, once
 * the value is known to be the right kind of thing at all.
 *
 * A `null` fits every like, because presence is `need`'s question and not the type's.
 * A record under a plain form fits when its `type` IS that form; under a union form its
 * `type` must be an arm, because that is what the union exists to say. A record lifted
 * with no form in hand (`object`) fits neither, and that is the refusal a repository
 * whose forms arrived after its data is meant to get. Until 2026-09-08 a plain form
 * fitted any record whatever its type, so an `any` of plain forms was answered by its
 * first arm for every value and a `walk` was checked as a heading.
 */
function fits(like: Like, value: Value, role: RoleBase | undefined): boolean {
  if (value.kind === 'null') {
    return true
  }
  if ('base' in like) {
    return baseKindMatches(like.base, value)
  }
  if ('ref' in like) {
    return value.kind === 'ref'
  }
  if ('record' in like) {
    if (value.kind !== 'record') {
      return false
    }
    const form = role?.forms.get(like.record)
    if (form?.arms) {
      return form.arms.includes(value.record.type)
    }
    return value.record.type === like.record
  }
  return like.any.some(arm => fits(arm, value, role))
}

/** A like as the words a diagnostic names it by. */
function describe(like: Like): string {
  if ('base' in like) {
    return like.base
  }
  if ('ref' in like) {
    return `ref ${like.ref}`
  }
  if ('record' in like) {
    return `record ${like.record}`
  }
  return `one of ${like.any.map(describe).join(', ')}`
}

/**
 * The form a nested record is validated against, or nothing when the like does not
 * name one it fits. Resolves a union to the arm the record's type names, and an `any`
 * to the first record arm that fits.
 */
function nestedForm(
  like: Like,
  record: RecordNode,
  role: RoleBase,
): Form | undefined {
  if ('record' in like) {
    const form = role.forms.get(like.record)
    if (!form) {
      return undefined
    }
    if (!form.arms) {
      return form
    }
    return form.arms.includes(record.type) ? role.forms.get(record.type) : undefined
  }
  if ('any' in like) {
    for (const arm of like.any) {
      const found = nestedForm(arm, record, role)
      if (found && fits(arm, { kind: 'record', record }, role)) {
        return found
      }
    }
  }
  return undefined
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

  // type conformance: the value, or every member of a collection, is of the like's kind
  if (!p.collection) {
    if (!fits(p.like, value, ctx.role)) {
      out.push({
        severity: 'hold',
        mark: node.mark,
        field: p.name,
        message: `expected ${describe(p.like)}, got ${value.kind === 'record' ? `record ${value.record.type}` : value.kind}`,
      })
    }
  } else if (value.kind === 'collection') {
    const wrong = value.items.find(it => !fits(p.like, it.value, ctx.role))
    if (wrong) {
      out.push({
        severity: 'hold',
        mark: node.mark,
        field: p.name,
        message: `collection member: expected ${describe(p.like)}, got ${wrong.value.kind === 'record' ? `record ${wrong.value.record.type}` : wrong.value.kind}`,
      })
    }
  }
  // A reference resolves within the dataset, and only when the form it points at is one
  // this role holds. A `ref` to a form the role does not hold points into ANOTHER
  // repository (a page's `workspace__id`, a word's `language__id`), and whether it
  // resolves is that repository's fact. One repository per form is the design, so most
  // references cross, and refusing every one of them would refuse every record.
  const held = ctx.role === undefined || ('ref' in p.like && ctx.role.forms.has(p.like.ref))
  if ('ref' in p.like && !p.collection && value.kind === 'ref' && ctx.dataset && held) {
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

  // recurse into nested records and record collections, validating each against the
  // form it resolves to: the named form, the union arm its type names, or the `any`
  // arm it fits. A record that resolves to nothing was already reported above.
  if (ctx.role && ('record' in p.like || 'any' in p.like)) {
    const role = ctx.role
    const nestedCtx = { dataset: ctx.dataset, role }
    const check = (record: RecordNode): void => {
      const form = nestedForm(p.like, record, role)
      if (form) {
        out.push(...validateRecord(record, form, nestedCtx))
      }
    }
    if (!p.collection && value.kind === 'record') {
      check(value.record)
    } else if (p.collection && value.kind === 'collection') {
      for (const it of value.items) {
        if (it.value.kind === 'record') {
          check(it.value.record)
        }
      }
    }
  }

  return out
}

/**
 * The form a top-level record is validated against: its own, or when its type names a
 * union, nothing, because a record is an instance of an arm and never of the union.
 */
function formFor(role: RoleBase, node: RecordNode): Form | undefined {
  const form = role.forms.get(node.type)
  return form && !form.arms ? form : undefined
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
    const form = formFor(role, node)
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
