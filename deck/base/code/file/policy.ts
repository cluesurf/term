import type { FileConfig, RoleBase } from '@/form/form'
import { globMatcher, matchesGlob } from '@/file/glob'
import { diffText, type Granularity, type Hunk } from '@/text/diff'
import { merge3Text, type TextMerge } from '@/text/merge'

// Applies a `role base`'s file rules: which files are opaque (never diffed, versioned
// as whole blobs) and, for the rest, at what granularity to diff and merge. This is
// how a generated `.tree` site opts its `build/**` output out of text diffing while its
// source files still get fine-grained diffs.

export class FilePolicy {
  private opaque: (path: string) => boolean

  constructor(private config: FileConfig = {}) {
    this.opaque = globMatcher(config.opaque ?? [])
  }

  // Whether a file is opaque (generated or derived): stored whole, never text diffed.
  isOpaque(path: string): boolean {
    return this.opaque(path)
  }

  // The diff granularity for a path: the first matching `diff` rule, else line-level.
  granularityFor(path: string): Granularity {
    for (const rule of this.config.diff ?? []) {
      if (matchesGlob(rule.match, path)) {
        return rule.granularity ?? 'line'
      }
    }
    return 'line'
  }
}

export function filePolicy(role: RoleBase): FilePolicy {
  return new FilePolicy(role.files ?? {})
}

// Diff a file under the policy. An opaque file returns undefined (no diff is produced,
// only whether the blob changed is meaningful). Otherwise it diffs at the policy's
// granularity for that path.
export function diffFile(
  policy: FilePolicy,
  path: string,
  before: string,
  after: string,
): Array<Hunk> | undefined {
  if (policy.isOpaque(path)) {
    return undefined
  }
  return diffText(before, after, policy.granularityFor(path))
}

// Merge a file under the policy. An opaque file is resolved as a whole: take the side
// that changed, keep it if both made the same change, else conflict on the whole file.
// A diffed file is three-way text merged at the policy's granularity.
export function mergeFile(
  policy: FilePolicy,
  path: string,
  base: string,
  a: string,
  b: string,
): TextMerge {
  if (policy.isOpaque(path)) {
    if (a === b) {
      return { clean: true, text: a, conflicts: 0, regions: [{ ok: [a] }] }
    }
    if (a === base) {
      return { clean: true, text: b, conflicts: 0, regions: [{ ok: [b] }] }
    }
    if (b === base) {
      return { clean: true, text: a, conflicts: 0, regions: [{ ok: [a] }] }
    }
    return {
      clean: false,
      text: `<<<<<<< a\n${a}\n=======\n${b}\n>>>>>>> b`,
      conflicts: 1,
      regions: [{ conflict: { a: [a], o: [base], b: [b] } }],
    }
  }
  return merge3Text(base, a, b, policy.granularityFor(path))
}
