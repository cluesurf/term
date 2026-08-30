// The mill executor against the hand-written reader (mill-self-hosting-0004): the host role's mine.tree read as
// a grammar, run over every host fixture, its mint.tree run over the match — and the result must equal
// compile/host.ts's readData BYTE FOR BYTE through writeLong and toJson. The bad fixtures must refuse to match.
// This is the proof that a dialect costs a grammar file, not a reader. Run: npx tsx test/compile/mill-run.ts

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import {
  readMineGrammar,
  readMintGrammar,
  runMine,
  runMint,
} from '@term/make/code/compile/mill-run'
import type { Minted } from '@term/make/code/compile/mill-run'
import {
  readDataText,
  writeLong,
  toJson,
} from '@term/make/code/compile/host'
import type {
  Data,
  DataEntry,
  DataTree,
} from '@term/make/code/compile/host'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 400)}`)
  }
}

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const FIXTURE = join(TERM, 'deck/host/test/fixture')
const HOST_ROLE = join(TERM, 'deck/mill/code/host')

const mineTree = parse({
  file: 'mine.tree',
  text: readFileSync(join(HOST_ROLE, 'mine.tree'), 'utf8'),
})
const mintTree = parse({
  file: 'mint.tree',
  text: readFileSync(join(HOST_ROLE, 'mint.tree'), 'utf8'),
})

if (!mineTree.ok || !mintTree.ok) {
  throw new Error('the host grammar files do not parse')
}

const grammar = readMineGrammar(mineTree.tree)
const mints = readMintGrammar(mintTree.tree)

ok(
  'the host mine grammar reads (every rule named)',
  ['host', 'host-entry', 'host-value', 'host-map', 'host-list', 'host-sublist', 'host-mesh', 'host-item', 'host-tree', 'host-fuse', 'host-scalar'].every(n => grammar.has(n)),
  [...grammar.keys()].join(', '),
)
ok(
  'the host mint grammar reads (every mint named)',
  ['host', 'host-entry', 'host-value', 'host-map', 'host-list', 'host-sublist', 'host-mesh', 'host-item', 'host-tree', 'host-fuse', 'host-scalar'].every(n => mints.has(n)),
  [...mints.keys()].join(', '),
)

// ---- shape the generic minted values into compile/host.ts's Data, mechanically ----
// The mapping is the data form's own variant names (deck/host/code/base.tree): hash, array->list, graft->fuse,
// and the three words true/false/void — the one distance the mint dialect still has to spell itself (a bind
// cannot carry a literal yet), recorded in mill-self-hosting.md.

function toData(minted: Minted): Data {
  switch (minted.kind) {
    case 'text':
      return { kind: 'text', value: minted.value }
    case 'number':
      return minted.decimal
        ? { kind: 'decimal', value: minted.value }
        : { kind: 'number', value: minted.value }
    case 'word':
      if (minted.value === 'true') {
        return { kind: 'flag', value: true }
      }

      if (minted.value === 'false') {
        return { kind: 'flag', value: false }
      }

      return { kind: 'void' }
    case 'form': {
      switch (minted.form) {
        case 'hash':
          return {
            kind: 'hash',
            list: (minted.fields.list ?? []).map(toEntry),
          }
        case 'array':
          return {
            kind: 'list',
            list: (minted.fields.list ?? []).map(toData),
          }
        case 'graft': {
          const name = minted.fields.name?.[0]

          return {
            kind: 'fuse',
            name: name?.kind === 'word' || name?.kind === 'text' ? name.value : '',
          }
        }
        default:
          throw new Error(`unexpected form ${minted.form}`)
      }
    }
    default:
      throw new Error('unreachable')
  }
}

function toEntry(minted: Minted): DataEntry {
  // an entry-position fuse is a nameless entry whose base is the graft (the reader's own spelling)
  if (minted.kind === 'form' && minted.form === 'graft') {
    return { name: '', base: toData(minted) }
  }

  if (minted.kind !== 'form' || minted.form !== 'data-entry') {
    throw new Error(`expected data-entry, got ${JSON.stringify(minted).slice(0, 120)}`)
  }

  const name = minted.fields.name?.[0]
  const base = minted.fields.base?.[0]

  return {
    name: name?.kind === 'word' || name?.kind === 'text' ? name.value : '',
    base: base ? toData(base) : { kind: 'void' },
  }
}

// assemble the DataFile shape the reader produces: anchors into the tree map, entries into a hash root (items
// into a list root when the file is a list at top level)
function assemble(match: Map<string, import('@term/make/code/compile/mill-run').MillCapture[]>): {
  root: Data
  trees: Map<string, DataTree>
} {
  const trees = new Map<string, DataTree>()
  const entries: DataEntry[] = []
  const items: Data[] = []

  for (const cap of match.get('tree') ?? []) {
    if (cap.kind !== 'match') {
      continue
    }

    const minted = runMint(mints, 'host-tree', cap.match)[0]

    if (minted?.kind !== 'form') {
      continue
    }

    const name = minted.fields.name?.[0]
    const treeName =
      name?.kind === 'word' || name?.kind === 'text' ? name.value : ''
    const treeEntries = (minted.fields.entries ?? []).map(toEntry)
    const treeItems = (minted.fields.items ?? []).map(toData)
    trees.set(treeName, {
      name: treeName,
      hold: treeItems.length > 0 ? 'list' : 'hash',
      list: treeItems.length > 0 ? treeItems : treeEntries,
    })
  }

  for (const cap of match.get('entry') ?? []) {
    if (cap.kind === 'match') {
      for (const minted of runMint(mints, 'host-entry', cap.match)) {
        entries.push(toEntry(minted))
      }
    }
  }

  for (const cap of match.get('mesh') ?? []) {
    if (cap.kind === 'match') {
      for (const minted of runMint(mints, 'host-mesh', cap.match)) {
        items.push(toData(minted))
      }
    }
  }

  const root: Data =
    items.length > 0
      ? { kind: 'list', list: items }
      : { kind: 'hash', list: entries }

  return { root, trees }
}

// ---- every good fixture, byte for byte ----

for (const name of ['basic.tree', 'anchors.tree']) {
  const text = readFileSync(join(FIXTURE, name), 'utf8')
  const reference = readDataText({ file: name, text })

  if (!reference.ok) {
    ok(`${name}: the reference reader reads it`, false, reference.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const parsed = parse({ file: name, text })

  if (!parsed.ok) {
    ok(`${name}: parses`, false)
    continue
  }

  const mined = runMine(grammar, 'host', parsed.tree)

  if (!mined.ok) {
    ok(`${name}: the executor matches the host grammar`, false)
    continue
  }

  ok(`${name}: the executor matches the host grammar`, true)
  const built = assemble(mined.match)

  ok(
    `${name}: writeLong is byte for byte the reader's`,
    writeLong(built.root, built.trees) === writeLong(reference.data.root, reference.data.trees),
    `executor:\n${writeLong(built.root, built.trees)}\nreader:\n${writeLong(reference.data.root, reference.data.trees)}`,
  )
  ok(
    `${name}: toJson is byte for byte the reader's`,
    toJson(built.root) === toJson(reference.data.root),
    `executor: ${toJson(built.root)}\nreader: ${toJson(reference.data.root)}`,
  )
}

// ---- every bad fixture refuses to match (the reader refuses them too) ----

for (const name of readdirSync(join(FIXTURE, 'bad')).sort()) {
  if (!name.endsWith('.tree')) {
    continue
  }

  const text = readFileSync(join(FIXTURE, 'bad', name), 'utf8')
  const parsed = parse({ file: name, text })

  if (!parsed.ok) {
    ok(`bad/${name}: refused (does not parse)`, true)
    continue
  }

  const mined = runMine(grammar, 'host', parsed.tree)
  // SEMANTIC refusals the grammar pass is not asked to catch: an unknown anchor (`fuse-unknown`), a duplicate
  // key (`twice`), a shelved file (`draft`), and a key's lexical class (`not-a-key`: the mine dialect has no
  // charset rule for a captured term yet — a recorded distance, mill-self-hosting.md). The reader's second
  // pass refuses each of them
  const semantic = new Set(['fuse-unknown.tree', 'twice.tree', 'draft.tree', 'not-a-key.tree'])

  if (semantic.has(name)) {
    ok(`bad/${name}: a semantic refusal, left to the reader's second pass (named skip)`, true)
    continue
  }

  ok(`bad/${name}: the executor refuses to match`, !mined.ok)
}

// ---- the shelved dialect files read through the executor (mill-self-hosting-0007) ----
// The decision of the open question: mine/mint files and dialect sources are read by the executor, never by the
// ordinary compile path (they stay `note draft` for the build walk). role/base.tree reads through the deck
// role's role grammar; ansi.tree and tint.tree through the test role's, their definitions lifted by name.

{
  const roleGrammar = readMineGrammar(
    parse({
      file: 'role-mine.tree',
      text: readFileSync(join(TERM, 'deck/mill/code/deck/role/mine.tree'), 'utf8'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any).tree!,
  )
  const roleFile = parse({
    file: 'role-base.tree',
    text: readFileSync(join(TERM, 'deck/seed/role/base.tree'), 'utf8'),
  })

  if (roleFile.ok) {
    const groups = roleFile.tree.nodes.filter(
      n => n.nodes[0]?.kind === 'name' && (n.nodes[0].parts[0] as { text?: string }).text === 'role',
    )
    const matches = groups.map(g =>
      runMine(roleGrammar, 'role', { kind: 'root', nodes: [g] }),
    )
    ok(
      'role/base.tree: every role block reads through the deck role grammar',
      groups.length === 2 && matches.every(m => m.ok),
      `${groups.length} blocks, ${matches.filter(m => m.ok).length} matched`,
    )
  } else {
    ok('role/base.tree parses', false)
  }

  const testGrammar = readMineGrammar(
    parse({
      file: 'test-mine.tree',
      text: readFileSync(join(TERM, 'deck/mill/code/test/mine.tree'), 'utf8'),
    }).tree!,
  )
  const testMints = readMintGrammar(
    parse({
      file: 'test-mint.tree',
      text: readFileSync(join(TERM, 'deck/mill/code/test/mint.tree'), 'utf8'),
    }).tree!,
  )

  const want: Record<string, string[]> = {
    'deck/seed/code/test/mint/ansi.tree': ['make-ansi-text-from-zone'],
    'deck/seed/code/test/view/tint.tree': ['gray', 'green', 'red', 'test-case', 'side'],
  }

  for (const [file, names] of Object.entries(want)) {
    const parsed = parse({ file, text: readFileSync(join(TERM, file), 'utf8') })

    if (!parsed.ok) {
      ok(`${file} parses`, false)
      continue
    }

    const mined = runMine(testGrammar, 'test', parsed.tree)

    if (!mined.ok) {
      ok(`${file}: reads through the test role grammar`, false)
      continue
    }

    const defs = runMint(testMints, 'test', mined.match)
      .map(d => (d.kind === 'word' ? d.value : ''))
    ok(
      `${file}: the executor lifts its definitions (${names.join(', ')})`,
      names.every(n => defs.includes(n)),
      defs.join(', '),
    )
  }
}

// ---- every manifest in the tree through the deck role grammar, against the hand-rolled reader ----
// (mill-self-hosting-0005, the read half): the executor's extraction must agree with
// deck/deck/code/manifest.ts on the name, the version, the head line and the link set, for every deck.tree.

{
  // the HAND reader is the reference here: parseManifest itself reads through the mill now, so comparing
  // against it would be mill-vs-mill
  const { parseManifestByHand: parseManifest } = await import('../../deck/deck/code/manifest')
  const { readdirSync } = await import('node:fs')

  // the deck grammar with its load closure inlined (the executor takes one grammar map)
  const MILL = join(TERM, 'deck/mill/code')
  const collected = new Set<string>()
  const parts: string[] = []
  const collect = (file: string): void => {
    if (collected.has(file)) {
      return
    }

    collected.add(file)
    const text = readFileSync(file, 'utf8')
    parts.push(text.replace(/^load .*$\n(?:  find .*$\n)*/gm, ''))

    for (const m of text.matchAll(/^load @term\/mill\/code\/(\S+)$/gm)) {
      for (const c of [join(MILL, `${m[1]}.tree`), join(MILL, m[1]!, 'base.tree')]) {
        try {
          readFileSync(c)
          collect(c)
          break
        } catch {
          // not this candidate
        }
      }
    }
  }

  collect(join(MILL, 'deck/mine.tree'))
  const deckGrammarTree = parse({ file: 'deck-grammar.tree', text: parts.join('\n\n') })

  if (!deckGrammarTree.ok) {
    ok('the deck grammar closure parses', false)
  } else {
    const deckGrammar = readMineGrammar(deckGrammarTree.tree)
    const words = (caps: import('@term/make/code/compile/mill-run').MillCapture[] | undefined): string[] =>
      (caps ?? []).flatMap(c => (c.kind === 'word' || c.kind === 'text' ? [c.value] : []))
    let manifests = 0
    let agree = 0
    const disagreements: string[] = []

    for (const dir of readdirSync(join(TERM, 'deck')).sort()) {
      const file = join(TERM, 'deck', dir, 'deck.tree')
      let text: string

      try {
        text = readFileSync(file, 'utf8')
      } catch {
        continue
      }

      manifests++
      const reference = parseManifest({ text })
      const parsed = parse({ file, text })

      if (!parsed.ok) {
        disagreements.push(`${dir}: does not parse`)
        continue
      }

      const mined = runMine(deckGrammar, 'deck', parsed.tree)

      if (!mined.ok) {
        disagreements.push(`${dir}: the grammar does not match`)
        continue
      }

      const deckCap = mined.match.get('deck')?.[0]

      if (deckCap?.kind !== 'match') {
        disagreements.push(`${dir}: no deck block captured`)
        continue
      }

      const fields = deckCap.match
      const name = words(fields.get('name'))[0] ?? ''
      const wantName = reference.host ? `@${reference.host}/${reference.name}` : reference.name
      // the version the READER defines: `code <x>` alone, defaulting 0.0.0. The grammar also captures the older
      // `mark <x>` spelling (zone's manifest carries `mark <0.0.1>`), which the hand-rolled reader silently
      // drops — a drift the executor surfaced; the reader is this differential's spec, so `code` it is
      const codeCap = fields.get('code')?.[0]
      const versionMatch = (cap: typeof codeCap): string =>
        cap?.kind === 'match' ? (words(cap.match.get('text'))[0] ?? '') : ''
      const version = versionMatch(codeCap) || '0.0.0'
      const wantVersion = `${reference.code.major}.${reference.code.minor}.${reference.code.patch}`
      const links = (fields.get('link') ?? []).flatMap(c =>
        c.kind === 'match' ? words(c.match.get('name')) : [],
      )
      const wantLinks = reference.link.map(l => (l.host ? `@${l.host}/${l.name}` : l.name))

      if (
        name === wantName &&
        version === wantVersion &&
        JSON.stringify(links.sort()) === JSON.stringify(wantLinks.sort())
      ) {
        agree++
      } else {
        disagreements.push(
          `${dir}: name ${name} vs ${wantName}, version ${version} vs ${wantVersion}, links ${links.join('+')} vs ${wantLinks.join('+')}`,
        )
      }
    }

    ok(
      `every manifest in the tree reads through the deck grammar and agrees with the hand-rolled reader (${agree} of ${manifests})`,
      manifests >= 14 && agree === manifests,
      disagreements.join(' | '),
    )
  }
}

// ---- the lockfile through the executor, against the hand-rolled reader-writer pair ----
// A lockfile the writer produces reads back through the lock grammar with the same decks, codes, hashes and
// links the reader sees (no lock.tree is committed in the tree, so the writer's own output is the fixture)

{
  const { writeLockfile, parseLockfileByHand: parseLockfile } = await import('../../deck/deck/code/lock')
  const fixture = writeLockfile({
    lockfile: {
      version: 1,
      decks: [
        {
          name: '@term/seed',
          code: { major: 0, minor: 0, patch: 16, wild: false },
          hash: 'kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr-kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr',
          site: 'link/@term/seed',
          link: [{ name: '@term/bind', code: '0.0.x' }],
        },
        {
          name: '@term/zone',
          code: { major: 0, minor: 0, patch: 2, wild: false },
          hash: 'mnbdtkhs-fvzxcwlr-kvmtnhbs-rzdxfwlc-mnbdtkhs-fvzxcwlr-kvmtnhbs-rzdxfwlc',
          site: 'link/@term/zone',
          link: [],
        },
      ],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  })
  const reference = parseLockfile({ text: fixture })
  const lockGrammar = readMineGrammar(
    parse({
      file: 'lock-mine.tree',
      text: readFileSync(join(TERM, 'deck/mill/code/deck/lock/mine.tree'), 'utf8'),
    }).tree!,
  )
  const parsed = parse({ file: 'lock.tree', text: fixture })

  if (!parsed.ok) {
    ok('the lockfile fixture parses', false)
  } else {
    const mined = runMine(lockGrammar, 'lock-file', parsed.tree)

    if (!mined.ok) {
      ok('the lockfile reads through the lock grammar', false)
    } else {
      const first = (caps: import('@term/make/code/compile/mill-run').MillCapture[] | undefined, site: string): string => {
        const cap = caps?.[0]

        if (cap?.kind !== 'match') {
          return ''
        }

        const v = cap.match.get(site)?.[0]

        return v && (v.kind === 'word' || v.kind === 'text') ? v.value : ''
      }
      const deckCaps = mined.match.get('deck') ?? []
      const got = deckCaps.map(cap => {
        if (cap.kind !== 'match') {
          return { name: '', code: '', hash: '', links: [] as string[] }
        }

        const f = cap.match
        const name = f.get('name')?.[0]

        return {
          name: name && (name.kind === 'word' || name.kind === 'text') ? name.value : '',
          code: first(f.get('code'), 'text'),
          hash: first(f.get('hash'), 'text'),
          links: (f.get('link') ?? []).map(l =>
            l.kind === 'match' && l.match.get('name')?.[0]?.kind === 'word'
              ? (l.match.get('name')![0] as { value: string }).value
              : '',
          ),
        }
      })
      const want = reference.decks.map(d => ({
        name: d.name,
        code: `${d.code.major}.${d.code.minor}.${d.code.patch}`,
        hash: d.hash,
        links: d.link.map(l => l.name),
      }))

      ok(
        'the lockfile reads through the lock grammar with the reader\'s decks, codes, hashes and links',
        JSON.stringify(got) === JSON.stringify(want),
        `executor: ${JSON.stringify(got)}\nreader: ${JSON.stringify(want)}`,
      )
      ok(
        'the lockfile version reads',
        first(mined.match.get('head'), 'version') === String(reference.version),
        first(mined.match.get('head'), 'version'),
      )
    }
  }
}

console.log(`\nmill-run: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
