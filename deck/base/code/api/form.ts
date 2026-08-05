// Form registration: declaring what a repository's records look like, and versioning it.
//
// A form is a schema. Registering one is the moment a restructuring becomes visible to
// everyone downstream, so this is where a breaking change is CAUGHT rather than where it
// is discovered later by a projection going NULL.
//
// The rule is that registration never silently breaks a registered consumer. A change that
// removes a property some contract reads is refused unless the caller says the break is
// intended, and even then the affected consumers are named in the answer so they can be
// pinned. That is the difference between a schema registry and a filing cabinet.
//
// See note/library/base/design/restructuring-records.md and consumer-contracts.md.

import type { Property } from '@term/base/code/form/form'
import type { Contract, Derivation } from '@term/base/code/project/contract'
import { readersOf } from '@term/base/code/project/contract'

/**
 * A form as registered, at a version.
 *
 * `version` counts up per form per repository. It is assigned here rather than supplied,
 * because a caller choosing its own version number is a caller that can overwrite history.
 */
export type FormVersion = {
  repository: string
  name: string
  version: number
  properties: Array<Property>
  // when this version was registered, for ordering and for reporting a pin point
  time: number
}

export type Break = {
  // the property that went away, and who was reading it
  form: string
  property: string
  consumers: Array<string>
}

export type Registration = {
  form: FormVersion
  // consumers whose contracts survive this change, either untouched or by derivation
  following: Array<string>
  // consumers that would break. Empty unless `force` was set, because otherwise the
  // registration is refused rather than returned.
  breaking: Array<Break>
}

export type FormFault =
  | { fault: 'bad-name'; name: string }
  | { fault: 'no-form'; name: string }
  // a change that removes something a registered consumer reads
  | { fault: 'breaking'; breaks: Array<Break> }

export type FormAnswer<T> = { ok: true; value: T } | ({ ok: false } & FormFault)

const yes = <T>(value: T): FormAnswer<T> => ({ ok: true, value })
const no = <T>(fault: FormFault): FormAnswer<T> => ({ ok: false, ...fault })

/** The seam. A host binds this to a table; the operations never touch a database. */
export type FormStore = {
  forms(repository: string): Promise<Array<FormVersion>>
  // every version of one form, newest first
  versions(input: {
    repository: string
    name: string
  }): Promise<Array<FormVersion>>
  putForm(form: FormVersion): Promise<void>
}

/** Names are used in paths and column names, so the same rule as a slug applies. */
export function checkFormName(name: string): FormFault | undefined {
  return /^[a-z][a-z0-9-]{0,62}$/.test(name)
    ? undefined
    : { fault: 'bad-name', name }
}

/**
 * What a change removes.
 *
 * Compares the properties by name. A property that changed TYPE is not reported here: that
 * is a different kind of break, caught by validation when a record fails to fit, and
 * conflating the two would make this answer harder to act on.
 */
export function removed(input: {
  before: Array<Property>
  after: Array<Property>
}): Array<string> {
  const after = new Set(input.after.map(property => property.name))

  return input.before
    .map(property => property.name)
    .filter(name => !after.has(name))
}

/**
 * Register a form version.
 *
 * The contract check runs BEFORE the write. A registration that would break a consumer is
 * refused with the consumers named, so the caller can pin them, adjust the change, or pass
 * `force` having decided the break is acceptable.
 */
export async function registerForm(
  store: FormStore,
  input: {
    repository: string
    name: string
    properties: Array<Property>
    contracts: Array<Contract>
    derivation?: Derivation
    time: number
    // proceed despite breaks. The breaks still come back in the answer: forcing a change
    // does not mean nobody needs to hear about it.
    force?: boolean
  },
): Promise<FormAnswer<Registration>> {
  const bad = checkFormName(input.name)

  if (bad) {
    return no(bad)
  }

  const history = await store.versions({
    repository: input.repository,
    name: input.name,
  })
  const previous = history[0]

  const breaks: Array<Break> = []

  if (previous) {
    for (const property of removed({
      before: previous.properties,
      after: input.properties,
    })) {
      // A renamed property is still gone under its old name. `derivation` is what says
      // otherwise, and a consumer reachable through it is NOT counted as broken.
      const renamed = input.derivation?.renames?.some(
        rename => rename.form === input.name && rename.from === property,
      )

      if (renamed) {
        continue
      }

      const consumers = readersOf({
        contracts: input.contracts,
        form: input.name,
        property,
      })

      if (consumers.length) {
        breaks.push({ form: input.name, property, consumers })
      }
    }
  }

  if (breaks.length && !input.force) {
    return no({ fault: 'breaking', breaks })
  }

  const form: FormVersion = {
    repository: input.repository,
    name: input.name,
    version: (previous?.version ?? 0) + 1,
    properties: input.properties,
    time: input.time,
  }

  await store.putForm(form)

  const broken = new Set(breaks.flatMap(one => one.consumers))

  return yes({
    form,
    following: input.contracts
      .map(contract => contract.consumer)
      .filter(consumer => !broken.has(consumer)),
    breaking: breaks,
  })
}

/** Every form registered in a repository, at its newest version. */
export async function listForms(
  store: FormStore,
  repository: string,
): Promise<FormAnswer<Array<FormVersion>>> {
  const all = await store.forms(repository)
  const newest = new Map<string, FormVersion>()

  for (const form of all) {
    const seen = newest.get(form.name)

    if (!seen || form.version > seen.version) {
      newest.set(form.name, form)
    }
  }

  return yes([...newest.values()].sort((a, b) => a.name.localeCompare(b.name)))
}

/** One form, at its newest version or at a named one. */
export async function readForm(
  store: FormStore,
  input: { repository: string; name: string; version?: number },
): Promise<FormAnswer<FormVersion>> {
  const history = await store.versions(input)
  const found =
    input.version === undefined
      ? history[0]
      : history.find(one => one.version === input.version)

  return found ? yes(found) : no({ fault: 'no-form', name: input.name })
}

/** Every version of a form, newest first, so a consumer can pin to one. */
export async function formHistory(
  store: FormStore,
  input: { repository: string; name: string },
): Promise<FormAnswer<Array<FormVersion>>> {
  return yes(await store.versions(input))
}

export const FORM_ROUTES = [
  { method: 'GET', path: '/repositories/:repository/forms' },
  { method: 'GET', path: '/repositories/:repository/forms/:form' },
  { method: 'GET', path: '/repositories/:repository/forms/:form/versions' },
  { method: 'POST', path: '/repositories/:repository/forms/register!' },
] as const

/** The HTTP status a form fault maps to. */
export function formStatus(result: { ok: boolean } & Partial<FormFault>): number {
  if (result.ok) {
    return 200
  }

  switch (result.fault) {
    case 'no-form':
      return 404
    // a refused registration is a CONFLICT with what consumers depend on, not a malformed
    // request, and a caller distinguishes the two by status alone
    case 'breaking':
      return 409
    default:
      return 400
  }
}
