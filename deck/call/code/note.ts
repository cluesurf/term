// `term note`: what a package says about itself, read from its deck.tree. Prints through the terminal output library
// (code/output.ts) the way the standard's Key-values card does: one `deck` item, the name as its subject and the
// version as a fact, the description as its message, license and authors as fields, and the dependencies as a list
// (section 14).

import { loadManifest, showCode } from '@cluesurf/deck.tree'
import { closeRun, count, field, makeItem, openRun, report } from '@term/call/code/output'
import type { ItemField } from '@term/call/code/work/item/event'

export async function callNote(input: {
  root: string
  deck?: string
}): Promise<void> {
  openRun({ verb: 'note', root: input.root })

  try {
    const manifest = await loadManifest({ dir: input.root })
    const fullName = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name

    const fields: ItemField[] = []

    if (manifest.lock) {
      fields.push(field('license', manifest.lock))
    }

    if (manifest.mind && manifest.mind.length > 0) {
      fields.push(field('authors', manifest.mind.map(f => f.name).join(', ')))
    }

    const item = makeItem({
      glyph: 'info',
      verb: 'deck',
      subject: fullName,
      facts: [showCode(manifest.mark)],
      message: manifest.head ? [manifest.head] : [],
      fields,
    })
    item.entries = manifest.link.map(dep => ({ label: dep.name, detail: '' }))
    report(item)

    closeRun({ verdict: `${fullName} read`, counts: [count(manifest.link.length, 'dependencies', 'dependency')] })
  } catch (err) {
    report({ glyph: 'failed', kind: 'problem', subject: err instanceof Error ? err.message : String(err) })
    closeRun({ verdict: 'No package to read', next: 'term wake, to make a package here' })
  }
}
