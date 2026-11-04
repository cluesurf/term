/**
 * JSON as base values, both ways, losing nothing.
 *
 * Every JSON that reaches base goes through here: a `jsonb` column mirrored from a
 * database, a page body posted by an editor, an importer's rows. One lifter and one
 * lowerer, because two converters disagree eventually, and the disagreement is a field
 * present on one path and absent on the other.
 *
 * THE LAW, held by `test/json-bridge.test.ts`: `lowerJson(liftJson(x))` deep-equals `x`
 * for every JSON `x`, and `liftJson(lowerJson(v))` is value-equal to `v` for every lifted
 * `v`. Before this module the projection lowered a record as `{ type, ...fields }` and an
 * integer as a string, so a page body came back out of base as something the page's own
 * checker refused.
 *
 * LIFTING IS DIRECTED BY THE FORM when one is in hand. A JSON object under a property
 * declared `{ record: 'content_heading' }` becomes a record of that type; one under a
 * union form becomes a record of the arm its discriminant names; a number under
 * `{ base: 'decimal' }` stays a decimal even when it happens to be whole. With no form
 * (a column base has no declaration for) the shape rules below apply and the record type
 * is `object`. Both paths lower identically, because the type is never written into the
 * JSON: a content node keeps its `form` key as an ordinary field, and that key is what
 * re-picks the arm on the way back in.
 *
 * IDENTITY IS THE `id` FIELD, at any depth, and nothing else. An object carrying an `id`
 * that reads as a mark (a tone code or a uuid) becomes a marked record, the `id` key is
 * taken out of its fields, and a list item holding it merges by identity. An object
 * without one is positional, deliberately: no `mark` field is invented and nothing is
 * minted onto content. An `id` that is neither spelling stays an ordinary text field, so
 * a foreign document with its own `id` vocabulary is not mistaken for one of ours.
 *
 * THE ONE EXCEPTION IS A FORM THAT DECLARES `id` AS A PROPERTY. A row form never does (a
 * row's `id` column is its mark and is left out of the form), and most value forms never
 * do, so the rule above holds everywhere it is meant to. But a `content_reference` node
 * carries `id` as the id of the record it POINTS AT, beside `base` and `slug`, and two
 * references to the same language must not become one node. When the form in hand says
 * `id` is a field, it is a field, and the object is positional like any other.
 *
 * Marks are stored as hex uuids and lowered as tone codes, which is the platform's
 * presentation form. See `canon/mark.ts`.
 *
 * See note/project/mesh/base-cutover/wordsurf-json-base.md.
 */

import type { Item, RecordNode, Value } from '@cluesurf/save/base/type'
import { decimal, integer, nul, text, boolean, list } from '@cluesurf/save/base/make'
import { isHexMark, isToneMark, toHexMark, toToneMark } from '@cluesurf/save/canon/mark'
import { armOf, UNION_KEY } from '@cluesurf/save/form/form'
import type { Form, Like, RoleBase } from '@cluesurf/save/form/form'

/** Any JSON. What a document and every value inside one is. */
export type Json =
  | string
  | number
  | boolean
  | null
  | Array<Json>
  | { [name: string]: Json }

/** The record type of a lifted object no form describes. */
export const OBJECT = 'object'

/** The field that carries identity. The same one a database row carries. */
export const ID = 'id'

export type LiftTake = {
  // the declared type of the value, when the schema is known
  like?: Like
  // the forms `like` names, for a nested record's own properties and a union's arms
  role?: RoleBase
}

/** Whether a string reads as a mark in either accepted spelling. */
export function readsAsMark(value: string): boolean {
  return isToneMark(value) || isHexMark(value)
}

/**
 * Whether a plain form admits an object, by the discriminant it declares.
 *
 * A form that is one kind of a family declares its kind as a one-option `pick` on the
 * union key (`form`), the way every `content_*` form does. Such a form admits only an
 * object carrying that kind. A form with no such pick admits any object: it is not one
 * of several, so there is nothing to tell apart. This is what lets an `any` of plain
 * forms pick its arm: without it the first arm answered for every object, and a `walk`
 * under a grid lifted as a `content_heading` and was refused as `not one of heading`.
 */
function admits(form: Form, json: { [name: string]: Json }): boolean {
  const key = form.key ?? UNION_KEY
  const property = form.properties.find(p => p.name === key)
  const picks = property?.constraints.filter(c => c.kind === 'pick') ?? []
  if (!picks.length) {
    return true
  }
  const tag = json[key]
  return typeof tag === 'string' && picks.some(c => c.options.includes(tag))
}

/**
 * The form a JSON object is an instance of, given what its slot declares.
 *
 * A plain form is the answer when it admits the object. A union form is answered by
 * its arm, picked by the discriminant the object carries. An `any` is answered by the
 * first record arm that admits the object. Nothing else answers, and the object lifts
 * as `object`.
 */
function formOf(
  json: { [name: string]: Json },
  like: Like | undefined,
  role: RoleBase | undefined,
): Form | undefined {
  if (!like || !role) {
    return undefined
  }
  if ('record' in like) {
    const form = role.forms.get(like.record)
    if (!form) {
      return undefined
    }
    if (!form.arms) {
      return admits(form, json) ? form : undefined
    }
    const tag = json[form.key ?? UNION_KEY]
    return typeof tag === 'string' ? armOf(role, form, tag) : undefined
  }
  if ('any' in like) {
    for (const arm of like.any) {
      const found = formOf(json, arm, role)
      if (found) {
        return found
      }
    }
  }
  return undefined
}

function liftNumber(value: number, like: Like | undefined): Value {
  if (!Number.isFinite(value)) {
    // NaN and the infinities have no JSON spelling either: JSON.stringify writes them as
    // null. Lifting them as null is the one reading that round trips.
    return nul()
  }
  const whole = Number.isInteger(value) && Number.isSafeInteger(value)
  if (like && 'base' in like) {
    if (like.base === 'decimal') {
      return decimal(String(value))
    }
    if (like.base === 'integer' && whole) {
      return integer(value)
    }
  }
  return whole ? integer(value) : decimal(String(value))
}

/**
 * A JSON value as a base value.
 *
 * `take.like` is the declared type of THIS value. For an array it is the element's
 * type, because a property carries its collection kind beside its like rather than
 * inside it, and every element is of the like.
 */
export function liftJson(json: Json, take: LiftTake = {}): Value {
  if (json === null) {
    return nul()
  }
  if (typeof json === 'string') {
    return text(json)
  }
  if (typeof json === 'number') {
    return liftNumber(json, take.like)
  }
  if (typeof json === 'boolean') {
    return boolean(json)
  }
  if (Array.isArray(json)) {
    return list(json.map(one => liftItem(one, take)))
  }
  return { kind: 'record', record: liftObject(json, take) }
}

/** One member of a list. A marked record marks the item, so the list merges by identity. */
function liftItem(json: Json, take: LiftTake): Item {
  const value = liftJson(json, take)
  const mark = value.kind === 'record' ? value.record.mark : undefined
  return mark === undefined ? { value } : { mark, value }
}

function liftObject(
  json: { [name: string]: Json },
  take: LiftTake,
): RecordNode {
  const form = formOf(json, take.like, take.role)
  const fields = new Map<string, Value>()
  let mark: string | undefined

  // see the header: a form that declares `id` is talking about something else's identity
  const idIsField = form?.properties.some(p => p.name === ID) ?? false

  for (const [name, inner] of Object.entries(json)) {
    if (name === ID && !idIsField && typeof inner === 'string' && readsAsMark(inner)) {
      mark = toHexMark(inner)
      continue
    }
    const property = form?.properties.find(p => p.name === name)
    fields.set(
      name,
      liftJson(inner, { like: property?.like, role: take.role }),
    )
  }

  const node: RecordNode = { type: form?.name ?? OBJECT, fields }
  if (mark !== undefined) {
    node.mark = mark
  }
  return node
}

/**
 * A base value as JSON. The exact inverse of `liftJson`.
 *
 * A record becomes an object of its lowered fields, with `id` restored from its mark as
 * a tone code and NEVER a `type` key: the form is recoverable from the discriminant field
 * the object still carries, and a key the author did not write must not appear in what
 * they read back. A `ref` and a `blob` are not JSON-lifted values and have no JSON
 * spelling of their own, so they keep the `{ ref }` and `{ blob }` envelopes the
 * projection used before this module existed.
 */
export function lowerJson(value: Value): Json {
  switch (value.kind) {
    case 'text':
    case 'date':
      return value.value
    case 'integer': {
      const number = Number(value.value)
      return Number.isSafeInteger(number) ? number : value.value.toString()
    }
    case 'decimal': {
      const number = Number(value.value)
      return Number.isFinite(number) ? number : value.value
    }
    case 'boolean':
      return value.value
    case 'null':
      return null
    case 'ref':
      return { ref: value.target }
    case 'blob':
      return { blob: value.hash }
    case 'collection':
      if (value.order === 'map' && value.items.every(item => item.key !== undefined)) {
        const out: { [name: string]: Json } = {}
        for (const item of value.items) {
          out[item.key!] = lowerJson(item.value)
        }
        return out
      }
      return value.items.map(item => lowerJson(item.value))
    case 'record': {
      const out: { [name: string]: Json } = {}
      if (value.record.mark !== undefined) {
        out[ID] = toToneMark(value.record.mark)
      }
      for (const [name, inner] of value.record.fields) {
        out[name] = lowerJson(inner)
      }
      return out
    }
  }
}
