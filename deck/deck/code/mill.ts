// The manifest and lockfile, read THROUGH THE MILL (mill-self-hosting-0005): the deck grammar in
// `deck/mill/code/deck` (inlined at build time by `pnpm run make:grammar`) is run by the executor
// (@term/make/code/compile/mill-run) over the parsed file, and the manifest is extracted from the captures. No
// hand-rolled extraction: when a reader and the mill disagree, the mill is right. Every diagnostic carries the
// SPAN of the node it is about, so an error names the line in deck.tree.

import { parse } from '@term/make/code/parser/tree'
import {
  readMineGrammar,
  runMine,
  spanOfNode,
} from '@term/make/code/compile/mill-run'
import type {
  MillCapture,
  MillMatch,
  MineGrammar,
} from '@term/make/code/compile/mill-run'
import { DECK_GRAMMAR, LOCK_GRAMMAR } from './grammar'
import type {
  DeckManifest,
  DeckLink,
  DeckMind,
  DeckHostGroup,
  Lockfile,
  LockEntry,
} from './form'
import { parseCode, parseCodeHold } from './code'

let deckGrammar: MineGrammar | undefined
let lockGrammar: MineGrammar | undefined

function grammarOf(text: string): MineGrammar {
  const parsed = parse({ file: 'grammar.tree', text })

  if (!parsed.ok) {
    throw new Error('the inlined deck grammar does not parse; rerun `pnpm run make:grammar`')
  }

  return readMineGrammar(parsed.tree)
}

// ---- capture helpers ----

function first(
  captures: MillCapture[] | undefined,
): MillCapture | undefined {
  return captures?.[0]
}

function word(capture: MillCapture | undefined): string | undefined {
  if (!capture) {
    return undefined
  }

  if (capture.kind === 'word' || capture.kind === 'text') {
    return capture.value
  }

  if (capture.kind === 'number') {
    return String(capture.value)
  }

  return undefined
}

// the single text/word a sub-match captured at `site`
function siteWord(
  capture: MillCapture | undefined,
  site: string,
): string | undefined {
  return capture?.kind === 'match'
    ? word(first(capture.match.get(site)))
    : undefined
}

function matches(
  captures: MillCapture[] | undefined,
): MillMatch[] {
  return (captures ?? []).flatMap(c =>
    c.kind === 'match' ? [c.match] : [],
  )
}

// ---- the manifest ----

export function parseManifestMill(input: {
  text: string
}): DeckManifest {
  deckGrammar ??= grammarOf(DECK_GRAMMAR)
  const parsed = parse({ file: 'deck.tree', text: input.text })

  if (!parsed.ok) {
    const at = parsed.diagnostics[0]

    throw new Error(
      `deck.tree could not be parsed${at ? `: ${at.message} (line ${at.span?.start.line ?? '?'})` : ''}`,
    )
  }

  const mined = runMine(deckGrammar, 'deck', parsed.tree)

  if (!mined.ok) {
    const at = spanOfNode(mined.at)

    throw new Error(
      `deck.tree does not fit the manifest grammar${at ? ` (line ${at.start.line})` : ''}`,
    )
  }

  const deckCapture = first(mined.match.get('deck'))

  if (deckCapture?.kind !== 'match') {
    throw new Error('deck.tree has no `deck` declaration')
  }

  const fields = deckCapture.match

  // `deck @scope/name`, or a bare `deck name` for an unscoped package
  let host = ''
  let name = word(first(fields.get('name'))) ?? ''
  const slash = name.indexOf('/')

  if (name.startsWith('@') && slash !== -1) {
    host = name.slice(1, slash)
    name = name.slice(slash + 1)
  }

  const code = parseCode(
    siteWord(first(fields.get('code')), 'text') ?? '0.0.0',
  )
  const head = siteWord(first(fields.get('head')), 'text')

  const mind = matches(fields.get('mind')).map(
    (m): DeckMind => {
      const entry: DeckMind = { name: word(first(m.get('name'))) ?? '' }
      const base = word(first(m.get('base')))
      const site = word(first(m.get('site')))

      if (base !== undefined) {
        entry.base = base
      }

      if (site !== undefined) {
        entry.site = site
      }

      return entry
    },
  )

  const lockCapture = first(fields.get('lock'))
  const lock =
    siteWord(lockCapture, 'term') ?? siteWord(lockCapture, 'text')
  const sortCapture = first(fields.get('sort'))
  const sort =
    siteWord(sortCapture, 'term') ?? siteWord(sortCapture, 'text')

  const term = matches(fields.get('term'))
    .map(m => word(first(m.get('text'))) ?? '')
    .filter(Boolean)

  const deck = matches(fields.get('deck'))
    .map(m => word(first(m.get('path'))) ?? '')
    .filter(Boolean)

  const toLink = (m: MillMatch): DeckLink | undefined => {
    const linkName = word(first(m.get('name')))

    if (!linkName) {
      return undefined
    }

    const hold = word(first(m.get('code')))
    const have = word(first(m.get('have')))
    const parsedHave =
      have === undefined ? undefined : Number.parseInt(have, 10)

    return {
      name: linkName,
      code: hold ? parseCodeHold(hold) : { form: 'wild', major: 0 },
      have:
        parsedHave !== undefined && Number.isFinite(parsedHave)
          ? parsedHave
          : undefined,
    }
  }

  const link = matches(fields.get('link'))
    .map(toLink)
    .filter((l): l is DeckLink => l !== undefined)

  const toHostGroup = (m: MillMatch): DeckHostGroup => ({
    registry: word(first(m.get('registry'))) ?? '',
    link: matches(m.get('link'))
      .map(toLink)
      .filter((l): l is DeckLink => l !== undefined),
  })

  // `case work` holds the dev dependencies, as `link` forms and `host` groups
  const work = matches(fields.get('case')).find(
    m => word(first(m.get('name'))) === 'work',
  )
  const devLink = work
    ? matches(work.get('link'))
        .map(toLink)
        .filter((l): l is DeckLink => l !== undefined)
    : []

  const hostLink = [
    ...matches(fields.get('host')).map(toHostGroup),
    ...(work ? matches(work.get('host')).map(toHostGroup) : []),
  ]

  const hook: Record<string, string> = {}

  for (const m of matches(fields.get('hook'))) {
    const hookName = word(first(m.get('name')))
    const hookTask = word(first(m.get('path')))

    if (hookName && hookTask) {
      hook[hookName] = hookTask
    }
  }

  const dir = (site: string): string | undefined =>
    siteWord(first(fields.get(site)), 'path')

  // `make <security>` is repeatable, and `cite` is `mind`'s shape under another head
  const make = matches(fields.get('make'))
    .map(m => word(first(m.get('text'))) ?? '')
    .filter(Boolean)

  const cite = matches(fields.get('cite')).map((m): DeckMind => {
    const entry: DeckMind = { name: word(first(m.get('name'))) ?? '' }
    const base = word(first(m.get('base')))

    if (base !== undefined) {
      entry.base = base
    }

    return entry
  })

  const markCapture = first(fields.get('mark'))
  const hideCapture = first(fields.get('hide'))
  const siteCapture = first(fields.get('site'))
  const viewCapture = first(fields.get('view'))

  return {
    host,
    name,
    code,
    head,
    mind: mind.length > 0 ? mind : undefined,
    lock,
    sort,
    term: term.length > 0 ? term : undefined,
    link,
    hook: Object.keys(hook).length > 0 ? hook : undefined,
    role: dir('role'),
    test: dir('test'),
    book: dir('book'),
    line: dir('line'),
    call: dir('call'),
    task: dir('task'),
    hide: hideCapture
      ? siteWord(hideCapture, 'flag') === 'true'
      : undefined,
    site: siteWord(siteCapture, 'text'),
    view: siteWord(viewCapture, 'text'),
    deck: deck.length > 0 ? deck : undefined,
    devLink: devLink.length > 0 ? devLink : undefined,
    hostLink: hostLink.length > 0 ? hostLink : undefined,
    // the fields this reader used to walk past. Anything read here has to be written back in writeManifest, or
    // the round trip DELETES it from the file. See the note on DeckManifest, and deck/deck/test/round-trip.ts.
    bear: dir('bear'),
    boot: dir('boot'),
    tool: dir('tool'),
    text: siteWord(first(fields.get('text')), 'text'),
    mark: siteWord(markCapture, 'text') ?? siteWord(markCapture, 'term'),
    make: make.length > 0 ? make : undefined,
    cite: cite.length > 0 ? cite : undefined,
  }
}

// ---- the lockfile ----

export function parseLockfileMill(input: {
  text: string
}): Lockfile {
  lockGrammar ??= grammarOf(LOCK_GRAMMAR)
  const parsed = parse({ file: 'lock.tree', text: input.text })

  if (!parsed.ok) {
    const at = parsed.diagnostics[0]

    throw new Error(
      `lock.tree could not be parsed${at ? `: ${at.message} (line ${at.span?.start.line ?? '?'})` : ''}`,
    )
  }

  const mined = runMine(lockGrammar, 'lock-file', parsed.tree)

  if (!mined.ok) {
    const at = spanOfNode(mined.at)

    throw new Error(
      `lock.tree does not fit the lockfile grammar${at ? ` (line ${at.start.line})` : ''}`,
    )
  }

  const versionText = siteWord(
    first(mined.match.get('head')),
    'version',
  )
  const stated = Number.parseInt(versionText ?? '', 10)
  const version = Number.isFinite(stated) ? stated : 1

  const decks: LockEntry[] = matches(mined.match.get('deck')).map(
    m => ({
      name: word(first(m.get('name'))) ?? '',
      code: parseCode(siteWord(first(m.get('code')), 'text') ?? '0.0.0'),
      hash: siteWord(first(m.get('hash')), 'text') ?? '',
      site: siteWord(first(m.get('site')), 'text') ?? '',
      link: matches(m.get('link')).map(l => ({
        name: word(first(l.get('name'))) ?? '',
        code: word(first(l.get('code'))) ?? '',
      })),
    }),
  )

  return { version, decks }
}
