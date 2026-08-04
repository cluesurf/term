// Relationship-based access control (Zanzibar style). Permissions are relationships
// between a user and a resource, checked against a role hierarchy. Resources nest
// (a field is under a form, a branch under the repo), so a grant on a parent applies
// to its children. An anonymous user is '*', for open, wiki-style repositories.
//
// See note/library/base/design/access-control-and-authorship.md.

// Actions in increasing authority. A role of a given rank grants that action and all
// weaker ones: commit implies propose implies read.
export type Action = 'read' | 'propose' | 'commit' | 'merge' | 'admin'

const RANK: Record<Action, number> = {
  read: 0,
  propose: 1,
  commit: 2,
  merge: 3,
  admin: 4,
}

// A resource is a string: 'repo', 'branch:main', 'form:word', 'field:word.gloss'.
export type Resource = string

function ancestors(resource: Resource): Array<Resource> {
  if (resource === 'repo') {
    return []
  }
  if (resource.startsWith('field:')) {
    const name = resource.slice('field:'.length)
    const form = name.split('.')[0]!
    return [`form:${form}`, 'repo']
  }
  // branch:X, form:X, and anything else sit directly under the repo
  return ['repo']
}

type Grant = { user: string; role: Action; resource: Resource }

export class AccessPolicy {
  private grants: Array<Grant> = []

  // Grant a user (or '*' for anonymous) a role on a resource.
  grant(user: string, role: Action, resource: Resource): void {
    this.grants.push({ user, role, resource })
  }

  // Whether a user may perform an action on a resource, considering resource
  // ancestry, the role hierarchy, and anonymous ('*') grants.
  can(user: string, action: Action, resource: Resource): boolean {
    const scope = new Set<Resource>([resource, ...ancestors(resource)])
    const need = RANK[action]
    for (const g of this.grants) {
      if (
        (g.user === user || g.user === '*') &&
        scope.has(g.resource) &&
        RANK[g.role] >= need
      ) {
        return true
      }
    }
    return false
  }
}

// A commit through any interface must pass this check: the user needs `commit` on
// the branch. Callers gate the repository commit on it.
export function authorizeCommit(
  policy: AccessPolicy,
  user: string,
  branch: string,
): boolean {
  return policy.can(user, 'commit', `branch:${branch}`)
}
