/**
 * The ref store: mutable branches and write-once versions, per package.
 *
 * Objects are immutable and content-addressed. Refs are the small,
 * consistency-critical layer on top (see note/term/registry/03 and 14):
 *
 *   - a VERSION is write-once: created once, frozen forever.
 *   - a BRANCH is mutable: it fast-forwards to new commits as you edit,
 *     resolved by a compare-and-set on its previous commit so a single
 *     editor never conflicts and a race resolves cleanly.
 *
 * This is the interface plus an in-memory implementation (for tests and a
 * single-process registry). The production store is Postgres, where a
 * UNIQUE(package, version) constraint IS the write-once guarantee.
 */

/** The reason a ref write was rejected, or null on success. */
export type RefError =
  | { kind: 'version-exists' }
  | { kind: 'branch-moved'; current: string | null }
  | null

export type RefStore = {
  getVersion(input: {
    package: string
    version: string
  }): Promise<string | null>
  createVersion(input: {
    package: string
    version: string
    commit: string
  }): Promise<RefError>
  listVersions(pkg: string): Promise<{ version: string; commit: string }[]>
  getBranch(input: {
    package: string
    branch: string
  }): Promise<string | null>
  setBranch(input: {
    package: string
    branch: string
    commit: string
    /** fast-forward guard: the commit the caller believes is current, or null for a new branch */
    expected?: string | null
  }): Promise<RefError>
  listBranches(pkg: string): Promise<{ branch: string; commit: string }[]>
}

/** An in-memory ref store for tests and single-process use. */
export function memoryRefStore(): RefStore {
  const versions = new Map<string, string>() // `${pkg}\0${version}` -> commit
  const branches = new Map<string, string>() // `${pkg}\0${branch}` -> commit

  const vkey = (p: string, v: string): string => `${p}\0${v}`
  const bkey = (p: string, b: string): string => `${p}\0${b}`

  return {
    async getVersion({ package: pkg, version }) {
      return versions.get(vkey(pkg, version)) ?? null
    },

    async createVersion({ package: pkg, version, commit }) {
      const key = vkey(pkg, version)

      if (versions.has(key)) {
        return { kind: 'version-exists' }
      }

      versions.set(key, commit)

      return null
    },

    async listVersions(pkg) {
      const out: { version: string; commit: string }[] = []

      for (const [key, commit] of versions) {
        const [p, version] = key.split('\0')

        if (p === pkg) {
          out.push({ version: version!, commit })
        }
      }

      return out
    },

    async getBranch({ package: pkg, branch }) {
      return branches.get(bkey(pkg, branch)) ?? null
    },

    async setBranch({ package: pkg, branch, commit, expected }) {
      const key = bkey(pkg, branch)
      const current = branches.get(key) ?? null

      // fast-forward compare-and-set: if the caller stated an expectation,
      // it must match the current head, else another writer moved it.
      if (expected !== undefined && expected !== current) {
        return { kind: 'branch-moved', current }
      }

      branches.set(key, commit)

      return null
    },

    async listBranches(pkg) {
      const out: { branch: string; commit: string }[] = []

      for (const [key, commit] of branches) {
        const [p, branch] = key.split('\0')

        if (p === pkg) {
          out.push({ branch: branch!, commit })
        }
      }

      return out
    },
  }
}
