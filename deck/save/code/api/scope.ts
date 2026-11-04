// The forms in scope at a point on the workspace tree, and the chain rules for declaring
// one.
//
// A form is declared at a SPACE and usable by every repository beneath it, or at one
// repository for itself. Resolution walks up: the repository's own forms, then each
// ancestor space nearest first, the FIRST declaration of a name winning. A name is
// declared once per chain: registering on a space refuses a name any ancestor declares
// (it would be shadowed), any descendant space declares, or any repository beneath
// declares (a declaration above would silently change what their records mean), and
// registering on a repository refuses a name an ancestor space declares. So resolution
// never has to choose.
//
// Two seams: the `FormStore` a host binds to its repository forms, and a second
// `FormStore` bound to its space forms with the workspace id in the `repository` slot.
// The tree comes from the `ControlStore`. Nothing here touches a database.
//
// See note/project/base/design/forms-per-space.md.

import type { FormStore, FormVersion } from '@cluesurf/save/api/form'
import type { ControlStore } from '@cluesurf/save/api/control'
import { chainOf, subtreeOf } from '@cluesurf/save/api/control'

/** Where a form in scope was declared. */
export type Declared =
  | { form: 'repository'; repository: string }
  | { form: 'space'; workspace: string; path: Array<string> }

/** A form as it applies at a point: its newest version and who declared it. */
export type ScopedForm = FormVersion & { declared: Declared }

/** The two stores a scope is read from. */
export type FormStores = {
  repositories: FormStore
  spaces: FormStore
}

/** The newest version of each form a store holds under one key. */
async function newest(store: FormStore, key: string): Promise<Array<FormVersion>> {
  const byName = new Map<string, FormVersion>()

  for (const form of await store.forms(key)) {
    const seen = byName.get(form.name)

    if (!seen || form.version > seen.version) {
      byName.set(form.name, form)
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The forms a SPACE sees: its own, then each ancestor's nearest first, first
 * declaration winning. What every repository beneath the space inherits.
 */
export async function spaceForms(input: {
  control: ControlStore
  stores: FormStores
  workspace: string
}): Promise<Array<ScopedForm>> {
  const chain = await chainOf(input.control, input.workspace)
  const out = new Map<string, ScopedForm>()

  for (const space of [...chain].reverse()) {
    for (const form of await newest(input.stores.spaces, space.id)) {
      if (!out.has(form.name)) {
        out.set(form.name, {
          ...form,
          declared: { form: 'space', workspace: space.id, path: space.path },
        })
      }
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * The forms a REPOSITORY is validated against: its own, then its space's chain. The
 * role a repository opens with is exactly this list.
 */
export async function repositoryForms(input: {
  control: ControlStore
  stores: FormStores
  repository: string
  // the repository's workspace, when the caller already has it; looked up otherwise
  workspace?: string
}): Promise<Array<ScopedForm>> {
  const own = (await newest(input.stores.repositories, input.repository)).map(
    (form): ScopedForm => ({
      ...form,
      declared: { form: 'repository', repository: input.repository },
    }),
  )
  const workspace = input.workspace ?? (await workspaceOf(input.control, input.repository))
  const inherited = workspace ? await spaceForms({ ...input, workspace }) : []
  const out = new Map<string, ScopedForm>()

  for (const form of [...own, ...inherited]) {
    if (!out.has(form.name)) {
      out.set(form.name, form)
    }
  }

  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function workspaceOf(
  control: ControlStore,
  repository: string,
): Promise<string | undefined> {
  if (control.workspaceOfRepository) {
    return control.workspaceOfRepository(repository)
  }

  for (const workspace of await control.workspaces()) {
    if ((await control.repositories(workspace.id)).some(one => one.id === repository)) {
      return workspace.id
    }
  }

  return undefined
}

/**
 * Every declaration of a name that stands in the way of declaring it on a SPACE:
 * above, below, and on any repository beneath. Empty means the space may declare it.
 */
export async function declarationsAgainstSpace(input: {
  control: ControlStore
  stores: FormStores
  workspace: string
  name: string
}): Promise<Array<Declared>> {
  const where: Array<Declared> = []
  const above = (await chainOf(input.control, input.workspace)).filter(
    one => one.id !== input.workspace,
  )
  const below = (await subtreeOf(input.control, input.workspace)).filter(
    one => one.id !== input.workspace,
  )

  for (const space of [...above, ...below]) {
    if ((await input.stores.spaces.forms(space.id)).some(one => one.name === input.name)) {
      where.push({ form: 'space', workspace: space.id, path: space.path })
    }
  }

  const self = await input.control.workspaceById(input.workspace)

  for (const space of self ? [self, ...below] : below) {
    for (const repository of await input.control.repositories(space.id)) {
      if (
        (await input.stores.repositories.forms(repository.id)).some(
          one => one.name === input.name,
        )
      ) {
        where.push({ form: 'repository', repository: repository.id })
      }
    }
  }

  return where
}

/**
 * Every declaration of a name that stands in the way of declaring it on a REPOSITORY:
 * a space on the chain above. Empty means the repository may declare it.
 */
export async function declarationsAgainstRepository(input: {
  control: ControlStore
  stores: FormStores
  repository: string
  name: string
}): Promise<Array<Declared>> {
  const workspace = await workspaceOf(input.control, input.repository)

  if (!workspace) {
    return []
  }

  return (await spaceForms({ ...input, workspace }))
    .filter(one => one.name === input.name)
    .map(one => one.declared)
}

/** Whether a name resolves on the chain above a workspace, the workspace included. */
export async function declaredOnChain(input: {
  control: ControlStore
  stores: FormStores
  workspace: string
  name: string
}): Promise<Declared | undefined> {
  return (await spaceForms(input)).find(one => one.name === input.name)?.declared
}
