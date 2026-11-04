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
// See note/project/base/design/restructuring-records.md and consumer-contracts.md.

import type { Form, Property, RoleBase } from '@cluesurf/save/form/form'
import { roleBase } from '@cluesurf/save/form/form'
import type { Contract, Derivation } from '@cluesurf/save/project/contract'
import { readersOf } from '@cluesurf/save/project/contract'
import type { Change, Dataset } from '@cluesurf/save/diff/change'
import { applyChanges } from '@cluesurf/save/patch/patch'
import { errors, validateDataset } from '@cluesurf/save/form/validate'
import type { Diagnostic } from '@cluesurf/save/form/validate'
import { convertDataset } from '@cluesurf/save/form/convert'
import type { Conversion, ConversionFault } from '@cluesurf/save/form/convert'

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
  // a UNION form: the arms a record under it may be, and the discriminant property that
  // picks one. Absent on an ordinary form. See `Form.arms` in form/form.ts.
  arms?: Array<string>
  key?: string
  // the moves that brought records from the version before to this one, kept with the
  // version so a branch behind it converts when it merges. See form/convert.ts.
  convert?: Conversion
}

export type Break = {
  // the property that went away, and who was reading it
  form: string
  property: string
  consumers: Array<string>
}

/** One branch the conversion of a registration landed on. */
export type ConversionCommit = {
  // the seam's name for the branch, for reporting
  branch: string
  commit: string
  changes: number
}

export type Registration = {
  form: FormVersion
  // consumers whose contracts survive this change, either untouched or by derivation
  following: Array<string>
  // consumers that would break. Empty unless `force` was set, because otherwise the
  // registration is refused rather than returned.
  breaking: Array<Break>
  // the conversion commits, one per branch that held records of the form; empty when the
  // registration carried no `convert` or nothing needed to move
  conversions: Array<ConversionCommit>
}

/**
 * A branch head the conversion of a registration runs over: what it holds, and how a
 * change set lands on it. Bound by the host to a repository and branch; the library never
 * touches a store. `write` commits against the NEW version, because the version is
 * written first, so a refusal there is a lost race and not a validation failure, which
 * the conversion has already run here.
 */
export type RecordSeam = {
  branch: string
  read(): Promise<Dataset>
  write(changes: Array<Change>): Promise<
    { ok: true; commit: string } | { ok: false; why: string }
  >
}

export type FormFault =
  | { fault: 'bad-name'; name: string }
  | { fault: 'no-form'; name: string }
  // a change that removes something a registered consumer reads
  | { fault: 'breaking'; breaks: Array<Break> }
  // records the conversion could not make fit the new version: the moves that refused,
  // and the diagnostics of the converted dataset against it. Nothing was written.
  | {
      fault: 'conversion'
      branch: string
      faults: Array<ConversionFault>
      diagnostics: Array<Diagnostic>
    }
  // the conversion was computed and checked but a branch would not take the commit (a
  // lost race). The version IS written; the branch is unconverted and named.
  | { fault: 'unconverted'; branch: string; why: string; form: FormVersion }

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

/**
 * Names are used in paths and column names, so the same rule as a slug applies.
 *
 * Underscore is allowed. A form is named for what its records are, and the platform
 * names those in snake_case everywhere (`content_heading`, `language_symbol`), with the
 * kebab spelling reserved for the one place a name becomes a URL segment. Until
 * 2026-09-07 this refused `_`, which refused every form the platform would register.
 */
export function checkFormName(name: string): FormFault | undefined {
  return /^[a-z][a-z0-9_-]{0,62}$/.test(name)
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
    // a union form's arms and discriminant, see FormVersion
    arms?: Array<string>
    key?: string
    // the moves that convert existing records to this version, and the branches they
    // apply to. See form/convert.ts. `records` without `convert` is a check only: the
    // heads are validated against the new version and a misfit refuses the registration.
    convert?: Conversion
    records?: Array<RecordSeam>
    // the other forms in scope at validation (a repository's inherited forms, say), so a
    // reference or a nested record resolves. Defaults to what the store holds for
    // `repository`, newest of each.
    scope?: Array<Form>
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
    ...(input.arms === undefined ? {} : { arms: input.arms }),
    ...(input.key === undefined ? {} : { key: input.key }),
    // stored with the version whether or not any branch was converted now: a branch
    // that is behind converts by these moves when it merges
    ...(input.convert && Object.keys(input.convert).length ? { convert: input.convert } : {}),
  }

  // THE CONVERSION IS COMPUTED AND CHECKED BEFORE ANYTHING IS WRITTEN. Every branch's
  // head is converted and validated against the new version in scope; one misfit
  // anywhere and neither the version nor any commit lands, with the record named.
  const planned: Array<{ seam: RecordSeam; changes: Array<Change> }> = []

  if (input.records?.length) {
    const scope = input.scope ?? (await newestForms(store, input.repository))
    const next: Form = {
      name: input.name,
      properties: input.properties,
      ...(input.arms === undefined ? {} : { arms: input.arms }),
      ...(input.key === undefined ? {} : { key: input.key }),
    }
    const role = roleBase([...scope.filter(one => one.name !== input.name), next])

    for (const seam of input.records) {
      const dataset = await seam.read()
      const converted = convertDataset({
        dataset,
        form: input.name,
        properties: input.properties,
        convert: input.convert ?? {},
      })
      const after = applyChanges(dataset, converted.changes)
      // only the records of THIS form: another form's misfit is not this registration's
      const diagnostics = errors(validateDataset(after, role)).filter(one => {
        const record = one.mark === undefined ? undefined : after.get(one.mark)

        return record?.type === input.name
      })

      if (converted.faults.length || diagnostics.length) {
        return no({
          fault: 'conversion',
          branch: seam.branch,
          faults: converted.faults,
          diagnostics,
        })
      }

      planned.push({ seam, changes: converted.changes })
    }
  }

  await store.putForm(form)

  const conversions: Array<ConversionCommit> = []

  for (const one of planned) {
    if (!one.changes.length) {
      continue
    }

    const landed = await one.seam.write(one.changes)

    if (!landed.ok) {
      return no({ fault: 'unconverted', branch: one.seam.branch, why: landed.why, form })
    }

    conversions.push({
      branch: one.seam.branch,
      commit: landed.commit,
      changes: one.changes.length,
    })
  }

  const broken = new Set(breaks.flatMap(one => one.consumers))

  return yes({
    form,
    following: input.contracts
      .map(contract => contract.consumer)
      .filter(consumer => !broken.has(consumer)),
    breaking: breaks,
    conversions,
  })
}

/** The newest version of every form a store holds for one key, as forms. */
async function newestForms(store: FormStore, repository: string): Promise<Array<Form>> {
  const listed = await listForms(store, repository)

  return listed.ok ? listed.value.map(formOf) : []
}

/**
 * The role a set of registered versions makes: the newest of each form, and every
 * version's conversion oldest first, so a merge can bring a branch that is behind up to
 * the newest. `versions` may hold every version of every form in any order.
 */
export function roleOfVersions(versions: Array<FormVersion>): RoleBase {
  const newest = new Map<string, FormVersion>()
  const conversions = new Map<string, Array<Conversion>>()

  for (const version of [...versions].sort((a, b) => a.version - b.version)) {
    const seen = newest.get(version.name)

    if (!seen || version.version > seen.version) {
      newest.set(version.name, version)
    }

    if (version.convert && Object.keys(version.convert).length) {
      const held = conversions.get(version.name) ?? []

      held.push(version.convert)
      conversions.set(version.name, held)
    }
  }

  const role = roleBase([...newest.values()].map(formOf))

  if (conversions.size) {
    role.conversions = conversions
  }

  return role
}

/** A registered version as the validator's form. */
export function formOf(version: FormVersion): Form {
  const form: Form = { name: version.name, properties: version.properties }

  if (version.arms !== undefined) {
    form.arms = version.arms
  }

  if (version.key !== undefined) {
    form.key = version.key
  }

  return form
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
    // the records refused the change: the request was well formed and the data was not,
    // which is what 422 is for
    case 'conversion':
      return 422
    // the version stands and a branch did not move: a conflict, retried by converting
    // that branch again
    case 'unconverted':
      return 409
    default:
      return 400
  }
}
