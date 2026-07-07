// Compute and apply dependency fixes: turn a set of dependency findings into a list of version upgrades, and rewrite
// the manifest (`deck.tree`) to pin the safe versions. Opening a pull request is intentionally NOT done here; the
// repository's own PR tool takes the rewritten manifest and opens the PR (create-only, never merge). This keeps the
// scanner honest: it computes and writes the patch, a human (or a separate bot) reviews and merges.

import fsp from 'fs/promises'
import path from 'path'
import type { DependencyFinding } from './form'

export type Upgrade = {
  name: string
  from: string
  to: string
  // the advisory ids this upgrade clears
  clears: string[]
}

// collapse findings into one upgrade per package (the highest fix version needed), listing the advisories cleared.
export function planUpgrades(findings: DependencyFinding[]): Upgrade[] {
  const byName = new Map<string, Upgrade>()

  for (const finding of findings) {
    if (!finding.fixVersion) {
      continue
    }

    const existing = byName.get(finding.node.name)

    if (existing) {
      existing.clears.push(finding.advisory.id)

      // keep the higher target if two advisories disagree (rare; planUpgrade already unifies per package)
      if (finding.fixVersion > existing.to) {
        existing.to = finding.fixVersion
      }
    } else {
      byName.set(finding.node.name, {
        name: finding.node.name,
        from: finding.node.version,
        to: finding.fixVersion,
        clears: [finding.advisory.id],
      })
    }
  }

  return [...byName.values()]
}

// rewrite a manifest's `link <name>, mark <range>` lines to the fixed versions (as a caret range). Returns the new
// manifest text. Only lines whose dependency name matches an upgrade are touched; everything else is byte-identical.
export function applyUpgradesToManifest(
  manifestText: string,
  upgrades: Upgrade[],
): string {
  const byName = new Map(upgrades.map(u => [u.name, u]))

  return manifestText
    .split('\n')
    .map(line => {
      // match `  link @scope/name, mark <range>` (the deck.tree dependency line)
      const match = /^(\s*link\s+)(\S+?)(\s*,\s*mark\s*)<[^>]*>(.*)$/.exec(
        line,
      )

      if (!match) {
        return line
      }

      const name = match[2]!
      const upgrade = byName.get(name)

      if (!upgrade) {
        return line
      }

      return `${match[1]}${name}${match[3]}<^${upgrade.to}>${match[4] ?? ''}`
    })
    .join('\n')
}

// read the manifest, apply the upgrades, and write it back. Returns the upgrades applied (those whose dependency
// line was found and rewritten). A dry run (default) computes the new text without writing.
export async function applyUpgrades(input: {
  root: string
  upgrades: Upgrade[]
  write?: boolean
}): Promise<{ applied: Upgrade[]; manifestText: string }> {
  const file = path.join(input.root, 'deck.tree')
  const original = await fsp.readFile(file, 'utf-8')
  const updated = applyUpgradesToManifest(original, input.upgrades)

  // an upgrade counts as applied only if it actually changed a line
  const applied = input.upgrades.filter(u =>
    new RegExp(
      `link\\s+${u.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,\\s*mark\\s*<\\^${u.to.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&',
      )}>`,
    ).test(updated),
  )

  if (input.write && updated !== original) {
    await fsp.writeFile(file, updated, 'utf-8')
  }

  return { applied, manifestText: updated }
}
