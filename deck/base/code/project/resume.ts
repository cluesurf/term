// The resume token: what an applier hands back to say where it got to.
//
// Base keeps NO per-consumer state. A consumer says "I am at X" and we compute the
// difference to the head, then forget. Per-consumer cursors on the server are O(consumers)
// of mutable state, they rot when a consumer disappears, and they are the part of every feed
// system that eventually needs its own repair tooling. Here the consumer holds its cursor
// and the server is a pure function of it.
//
// That makes this string the entire interface, and a bare commit hash is not enough for it.
// A hash alone cannot tell an applier that:
//
//   its mapping went stale        the schema moved, so rows written since are missing a
//                                 column and it has no way to know
//   the canonical form changed    hashes it computes no longer mean what ours mean
//   the token is not even ours    a token from another repository is a VALID hash here, so
//                                 it would resolve to something unrelated rather than fail
//
// Each of those is a silent wrong answer where a refusal is wanted, and each becomes
// unfixable once third parties hold tokens, because you cannot go back and add a field to a
// string somebody already stored.
//
// So the token is SELF-DESCRIBING and OPAQUE. Self-describing so it can carry a new field
// later without every applier being rewritten; opaque so no applier is depending on the
// shape when that happens. `C1` in the applier contract is the whole of an applier's
// obligation here: store it, hand it back, never parse it.
//
// On the encoding: the commit travels in base's own address form, `sha256:<hex>`, which is
// how base addresses everything internally and what a projection's watermark already holds.
// The house tone-code convention applies where a value is SHOWN to a person; this is a
// machine token in a wire protocol, and re-encoding it here would mean either duplicating
// the tone alphabet into this package or making the protocol depend on a presentation
// concern. Tone-coding belongs at the point a token is displayed, not at the point it is
// exchanged.
//
// See note/library/base/design/projection-sync-protocol.md §1a and §1b.

// The token's own format version, which is not the canonical form's. Bumping this changes
// how the STRING is read; the canonical form inside it changes what the bytes MEAN. They
// move for different reasons, so they are separate fields.
const TOKEN_VERSION = 1

const PREFIX = 'resume'

// A field separator that cannot occur inside any component. A commit carries a colon
// (`sha256:...`), a repository is a uuid, and both versions are word characters, so a space
// is free and stays readable in a log line.
const SEPARATOR = ' '

export type Resume = {
  // which repository this cursor belongs to, so a token from another one is refused rather
  // than silently resolving
  repository: string
  // the commit the applier has applied through
  commit: string
  // the canonical form the commit's bytes were written under
  canonical: string
  // the shape of the projection the applier built. Optional, because a consumer that does
  // not project into a schema (a search index, a file dump) has no mapping to describe
  mapping?: string
}

export type ResumeProblem =
  | 'malformed'
  | 'unknown-token-version'
  | 'wrong-repository'
  | 'unreadable-canonical-form'
  | 'stale-mapping'

export type ResumeCheck =
  | { ok: true; resume: Resume }
  | { ok: false; problem: ResumeProblem; detail: string }

/** Render a cursor as the opaque string an applier stores. */
export function encodeResume(resume: Resume): string {
  return [
    `${PREFIX}/${TOKEN_VERSION}`,
    resume.repository,
    resume.commit,
    resume.canonical,
    resume.mapping ?? '-',
  ].join(SEPARATOR)
}

/**
 * Read a token back, and check it against what this server expects.
 *
 * Every refusal is specific. "Your token is invalid" leaves an applier with nothing to do,
 * while "your mapping is stale" and "this token is for another repository" each name a
 * different action.
 *
 * An absent token is not an error and is not handled here: a fresh applier has none, and its
 * first request is a bootstrap rather than a resume.
 */
export function decodeResume(input: {
  token: string
  // the repository the request is against
  repository: string
  // the canonical forms this server can serve
  readable: ReadonlySet<string>
  // the mapping version the applier's projection is currently derived at, when it has one.
  // A token whose mapping differs describes rows written through a shape that no longer
  // holds, so resuming from it would leave the difference permanently unfilled.
  mapping?: string
}): ResumeCheck {
  const part = input.token.split(SEPARATOR)

  if (part.length !== 5) {
    return { ok: false, problem: 'malformed', detail: 'expected five fields' }
  }

  const [tag, repository, commit, canonical, mapping] = part as [
    string,
    string,
    string,
    string,
    string,
  ]

  const [prefix, version] = tag.split('/')

  if (prefix !== PREFIX) {
    return { ok: false, problem: 'malformed', detail: `not a ${PREFIX} token` }
  }

  if (version !== String(TOKEN_VERSION)) {
    // A newer token from a newer applier. Refusing is right: this server cannot know what
    // fields it carries, and guessing would be worse than saying so.
    return {
      ok: false,
      problem: 'unknown-token-version',
      detail: `token version ${version ?? '(none)'} is not ${TOKEN_VERSION}`,
    }
  }

  if (repository !== input.repository) {
    // The failure this field exists for. A commit hash from another repository is a VALID
    // hash here, so without the check it would resolve to something unrelated rather than
    // fail, and a customer would be served another customer's history.
    return {
      ok: false,
      problem: 'wrong-repository',
      detail: `token is for ${repository}, not ${input.repository}`,
    }
  }

  if (!input.readable.has(canonical)) {
    return {
      ok: false,
      problem: 'unreadable-canonical-form',
      detail: `canonical form ${canonical} is not readable by this server`,
    }
  }

  const held = mapping === '-' ? undefined : mapping

  if (input.mapping !== undefined && held !== undefined && held !== input.mapping) {
    return {
      ok: false,
      problem: 'stale-mapping',
      detail: `token was written through mapping ${held}, projection is now ${input.mapping}`,
    }
  }

  return {
    ok: true,
    resume: {
      repository,
      commit,
      canonical,
      ...(held === undefined ? {} : { mapping: held }),
    },
  }
}
