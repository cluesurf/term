<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<p align='center'>
  <img src='https://github.com/cluesurf/base/blob/make/view/view.png?raw=true' height='192'>
</p>

<h3 align='center'>
  base
</h3>
<p align='center'>
  A Resource Registry Ω
</p>

<br/>
<br/>
<br/>

## Introduction

base is a version-control system for structured knowledge data: a
resource database. Where git versions files as lines of text, base
versions a graph of typed, identified records, so it can diff and merge
at the level of a record and a field, with the evidence behind each
value, which line-based tools cannot. It is built for
human-and-agent-edited reference data: dictionaries, lexicons, script
and language metadata, phoneme inventories, and catalogs, the kind of
data that is continually corrected, reviewed, cited, and depended on.

Every resource carries a mark, a stable identity, so a record is the
unit of history rather than a file. Edits to different fields of the
same record merge automatically, and only concurrent edits to the same
field conflict, surfaced with each side's evidence rather than resolved
silently. Schemas are forms with declarative constraints, checked as a
gate on every commit. The store underneath is a content-addressed prolly
tree, so a state is named by one hash, unchanged data is shared across
versions, and a diff or a sync costs the size of the change rather than
the size of the dataset.

The history is the source of truth, and a database is a rebuildable
projection of it, so reads are as fast as an indexed database while
writes keep git-like trust. Any read surface, a relational cache, a
search index, or a custom in-memory index, is a subscriber to one change
feed. The same design supports editing from a normal git-style clone, a
live per-record session like a shared document, and open contribution at
scale.

## Version Meaning, Not Serialization

base does not version text. It versions the meaning: a record graph of
marks, typed fields, references, and provenance. `.tree` is the readable
syntax you author in, JSON is the wire and export form, and a
content-addressed prolly tree is how it is stored, but all three are
surfaces on one model. Because identity is the mark and merge is
semantic per field, the same merge serves a live editing session, a wiki
save, and a pull request, differing only in latency and review.

This is what turns a dataset into infrastructure. A state is a hash, so
a release is immutable and citeable, and a mirror catches up by diffing
two roots and fetching only what changed rather than replaying a
firehose. A commit carries not just a message but the reason, the
sources, and the field-level changes, so history is auditable rather
than a log of file edits. And because the store is content-addressed, a
cache keyed by a record and its version never goes stale, so real-time
editing and fast queries stop being at odds.

## Modules

The library is one package. Each part of `code/` is a layer that the
ones above build on.

| Module             | Purpose                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `base/`            | the record model: marks, typed values, builders, structural equality  |
| `canon/`           | canonical serialization, reversible decode, content hashing           |
| `diff/`, `patch/`  | field-level semantic diff and apply                                   |
| `merge/`           | three-way semantic merge, hybrid logical clock and tie-break          |
| `form/`            | forms and `hold`/`want` constraints, validation, auto-marking         |
| `store/`           | the prolly tree, R2 (chunks) and CockroachDB/Postgres (refs) backends |
| `text/`            | token-level text diff and three-way merge, finer than line-level      |
| `file/`            | per-`role base` file rules: opt generated output out of text diffing  |
| `commit/`, `repo/` | commits, branches, merge, cherry-pick, revert, rebase, push and pull   |
| `reflog/`          | ref-move history, for recovering a lost or rewritten head             |
| `verify/`          | fsck: whole-graph integrity verification by re-hashing                |
| `project/`         | projections and the change feed                                       |
| `query/`           | the query surface with declared equality and ordered indexes          |
| `lookup/`          | reverse-reference and mark-to-commits indexes for scale               |
| `history/`         | field-level blame, record history, and bisect                         |
| `migrate/`         | schema migration by idempotent upcasting                              |
| `identity/`        | redirect, split, referential actions, and the move-aware tree CRDT    |
| `merge/`           | semantic merge, per-field policy, and the conflict-resolution session  |
| `tree/`            | the `.tree` parser and formatter                                      |
| `sync/`, `transport/` | replica sync, partial and shallow fetch, bundles, remote push/pull |
| `live/`            | ephemeral presence and soft leases, kept out of durable history       |
| `access/`          | relationship-based access control and ed25519 signed commits          |
| `redact/`          | redaction, crypto-shredding, and reversible redaction                 |
| `gc/`, `erase/`    | garbage collection, hard erasure, and revocation propagation          |
| `offhistory/`      | mutable two-tier store for regulated, truly-deletable content         |

## How It Works

```
.tree source
    ↓ parse
record graph  (marks, typed fields, references, provenance)
    ↓ version, diff, merge, validate
prolly-tree store  (content-addressed, structurally shared)   ← the source of truth
    ↓ project
database, search, custom indexes  (rebuildable read caches)
    ↓ serve
API and exports  (.tree, JSON, JSONL, CSV, SQLite)
```

A commit stores each changed record by its canonical hash, updates only
the tree path it touches, and lands on a branch through a
compare-and-swap with an automatic semantic rebase when a concurrent
edit arrives. A projection subscribes to the change feed and updates
incrementally, and can always be rebuilt from history. The full design
lives in `note/library/base/`.

## Installation

```
pnpm add @cluesurf/base
```

## Getting Started

```ts
import {
  Repository,
  MemoryChunkStore,
  MemoryRefStore,
  datasetOf,
  record,
  text,
  form,
  property,
  hold,
  roleBase,
  MemoryProjection,
  sync,
} from '@cluesurf/base'

const role = roleBase([
  form('word', [
    property('term', { base: 'text' }, { constraints: [hold('need')] }),
  ]),
])
const repo = new Repository(
  new MemoryChunkStore(),
  new MemoryRefStore(),
  role,
)

repo.commit(
  'main',
  { author: 'alice', time: Date.now(), message: 'add foo' },
  datasetOf([
    record({
      type: 'word',
      mark: 'a3f...-uuid',
      fields: { term: text('foo') },
    }),
  ]),
)

const projection = new MemoryProjection()
sync(repo, 'main', projection)
projection.where('word', 'term', text('foo'))
```

## Example

A resource in `.tree`, the readable authoring syntax:

```tree
word སྨན
  mark <4f9a2c10-8b3e-4c1a-9f22-7d6e0a1b2c3d>
  language @ref language:bo
  senses @list
    - sense ^a1b2c3d4-1111-2222-3333-444455556666
        gloss medicinal compound
        source @ref source:dictionary-x
```

## License

MIT

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe ¤.
Follow the work on [YouTube](https://youtube.com/@cluesurf),
[X](https://x.com/cluesurf),
[Instagram](https://instagram.com/cluesurf),
[Substack](https://cluesurf.substack.com),
[Facebook](https://facebook.com/cluesurf), and
[LinkedIn](https://linkedin.com/company/cluesurf), and browse more of
our open-source work here on [GitHub](https://github.com/cluesurf).
