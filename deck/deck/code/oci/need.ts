// A project's `need`, pinned: the exact toolchain release a `need @term/code, mark <2.6.x>` resolves to, and the
// digest of that release's image index, which `lock.tree` records (note/term/plan/term-versions.md, "Files").
//
// THE INDEX DIGEST, NOT A LAYER DIGEST. A release is one image index with a manifest per platform, so the index digest
// covers every platform's build at once: a teammate on Linux and one on a Mac pin the same thing, and an install checks
// the platform it runs on against it through the index.
//
// A PIN THAT STILL SATISFIES THE REQUEST IS KEPT. `term load` re-resolves only when the request moved past the pin, the
// way a lockfile keeps every other dependency, so a project does not drift to a newer toolchain because one was
// released.

import { codeMatch, compareCode, parseCode, showCode } from '../code'
import type { CodeHold, DeckNeed, LockNeed } from '../form'
import { releaseRoute } from './release'
import { transportFor } from './client'
import type { OciTransport } from './transport'

/** The one package a `need` may name today: the toolchain. */
export const TOOLCHAIN = '@term/code'

const VERSION = /^\d+\.\d+\.\d+$/

/** Every version released under the toolchain's repository, newest first. */
export async function releasedVersions(input: { transport: OciTransport; repository: string }): Promise<string[]> {
  const tags = await input.transport.listTags({ repository: input.repository })

  return tags
    .filter(tag => VERSION.test(tag))
    .sort((a, b) => compareCode(parseCode(b), parseCode(a)))
}

/** The newest version in a list (newest first) that a request accepts. */
export function newestMatching(input: { versions: string[]; hold: CodeHold }): string | undefined {
  return input.versions.find(version => codeMatch(parseCode(version), input.hold))
}

/** Does a pinned version still satisfy the request it was pinned for? */
export function pinSatisfies(input: { need: DeckNeed; pin: LockNeed | undefined }): input is { need: DeckNeed; pin: LockNeed } {
  return Boolean(input.pin && input.pin.name === input.need.name && codeMatch(input.pin.code, input.need.mark))
}

/**
 * Pin a project's `need`. Keeps the previous pin while it satisfies the request; otherwise resolves the newest released
 * version in the range and reads its index digest. Offline, an unsatisfied request keeps no pin rather than guessing,
 * and the caller says so.
 */
export async function pinNeed(input: {
  need: DeckNeed
  previous?: LockNeed
  offline?: boolean
}): Promise<{ pin?: LockNeed; kept: boolean; reason?: string }> {
  if (input.need.name !== TOOLCHAIN) {
    return { kept: false, reason: `need names ${input.need.name}, and only ${TOOLCHAIN} can be needed` }
  }

  if (pinSatisfies({ need: input.need, pin: input.previous })) {
    return { pin: input.previous, kept: true }
  }

  if (input.offline) {
    return { kept: false, reason: `the toolchain request is not pinned, and an offline load cannot read the releases` }
  }

  const route = releaseRoute({ package: TOOLCHAIN })
  const transport = transportFor({ host: route.registry.host })
  const versions = await releasedVersions({ transport, repository: route.repository.name })
  const version = newestMatching({ versions, hold: input.need.mark })

  if (!version) {
    return {
      kept: false,
      reason: `${TOOLCHAIN} has no release in the requested range${versions[0] ? `. The newest is ${versions[0]}` : ''}`,
    }
  }

  const index = await transport.getManifest({ repository: route.repository.name, reference: version })

  if (!index) {
    return { kept: false, reason: `${TOOLCHAIN}@${version} is listed and could not be read` }
  }

  return { pin: { name: TOOLCHAIN, code: parseCode(version), hash: index.digest }, kept: false }
}

/** A pin, as one line a person reads: `@term/code 2.6.4 (sha256:…)`. */
export function showPin(pin: LockNeed): string {
  return `${pin.name} ${showCode(pin.code)} (${pin.hash})`
}
