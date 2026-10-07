// A fake find driver for the tests of @term/base/find (spec section 9): an in-memory tree read from a JSON file,
// spoken to in JSON lines on standard input and output. Usage: node fake-driver.js <tree.json> <log-path>
//
// The tree file holds `{ "backend": "memory", "part": [...], "node": [{ "id", "kind", "parent", "prop": {...} }] }`.
// `part` is what `hello` advertises: the query parts this driver executes (`have`, `lack`, ... and NOT `hold` or `meet`
// unless listed), so the engine decides the rest in Term. A part not listed is refused with `cannot` if it arrives.
// Every `find` and `call` is appended to the log file as one JSON line, so a test can read what reached the driver.
//
// Nothing in a message is ever evaluated as code: a message is parsed as data and its fields are only compared.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [treePath, logPath] = process.argv.slice(2)
const tree = JSON.parse(readFileSync(treePath, 'utf8'))
const nodes = tree.node
const parts = tree.part

if (logPath) {
  writeFileSync(logPath, '')
}

const log = entry => {
  if (logPath) {
    appendFileSync(logPath, `${JSON.stringify(entry)}\n`)
  }
}

const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

const handleOf = node => ({ tool: tree.backend, id: node.id, kind: node.kind })

const byId = id => nodes.find(node => node.id === id)

// every node under `node`, at any depth
const below = node => {
  const out = []

  for (const child of nodes.filter(other => other.parent === node.id)) {
    out.push(child, ...below(child))
  }

  return out
}

// a test the driver advertises is decided here, one it does not is refused
const holds = (test, node) => {
  if (test.form === 'have') {
    return same(node.prop?.[test.name], test.value)
  }

  if (test.form === 'lack') {
    return !same(node.prop?.[test.name], test.value)
  }

  throw { kind: 'cannot', detail: `${tree.backend} does not execute ${test.form}` }
}

const step = (pool, wanted) =>
  pool.filter(
    node => (wanted.kind === '' || node.kind === wanted.kind) && wanted.test.every(test => holds(test, node)),
  )

const find = message => {
  const query = message.query
  const from = message.from ?? []
  let pool = nodes

  if (from.length > 0) {
    pool = from.flatMap(handle => {
      const node = byId(handle.id)

      return node ? below(node) : []
    })
  }

  let hits = step(pool, query.base)

  for (const next of query.path) {
    const seen = new Set()
    const found = []

    for (const node of hits.flatMap(below)) {
      if (!seen.has(node.id)) {
        seen.add(node.id)
        found.push(node)
      }
    }

    hits = step(found, next)
  }

  if (message.limit > 0) {
    hits = hits.slice(0, message.limit)
  }

  return { hits: hits.map(handleOf) }
}

const answer = message => {
  if (message.op === 'hello') {
    return { tool: tree.backend, version: 1, kinds: [], part: parts }
  }

  if (message.op === 'find') {
    log({ op: 'find', limit: message.limit, count: message.query.count })

    return find(message)
  }

  if (message.op === 'read') {
    const node = byId(message.handle.id)

    if (!node) {
      throw { kind: 'gone', detail: message.handle.id }
    }

    return { value: node.prop?.[message.name] ?? null }
  }

  if (message.op === 'call') {
    log({ op: 'call', name: message.name, take: message.take, handle: message.handle })

    return { value: null }
  }

  throw { kind: 'cannot', detail: `no op ${message.op}` }
}

const lines = createInterface({ input: process.stdin })

lines.on('line', line => {
  let message

  try {
    message = JSON.parse(line)
  } catch {
    return
  }

  try {
    process.stdout.write(`${JSON.stringify({ id: message.id, ok: true, ...answer(message) })}\n`)
  } catch (error) {
    const reason = error && error.kind ? error : { kind: 'native', detail: String(error) }

    process.stdout.write(`${JSON.stringify({ id: message.id, ok: false, error: reason })}\n`)
  }
})
