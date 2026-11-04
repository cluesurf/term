// Writes deck/make/code/compile/node-rebuild.tree: ONE rebuild step every walk shares (decision 044). Given a node and its
// new children, in the order compile/node-children.tree hands them out, it answers a FRESH parent: a new node, every
// record between the node and a child made new too (a branch, a field value, a map entry, a parameter, a dock's parts),
// and each child put where the old one stood. It never writes its input. Generated from compile/node.tree, as
// node-json-gen.ts writes node-json.tree from it, so a case or field added to node.tree reaches the step on the next
// generate. Edit THIS file, never the .tree.
//
//   npx tsx task/term/node-rebuild-gen.ts [--write | --check | --out <path>]
//
// Without a flag it prints what it would write. --check exits 1 when the committed file differs from what it would write.
// The rules:
//   - a child is a field that holds an expression, a statement, a type or a view node, at any depth through records,
//     lists and maybes, met in node.tree's declared order: node-children's order. A key named in `skip` is not entered,
//     at every depth, as node-children does not enter it: the field is left as it was and takes no child
//   - NOT_CHILDREN names the fields node-children never enters: they are left as they were
//   - a record is made new by a shallow copy (`{ ...value }` on TypeScript, the value itself natively, as
//     ir/simplifying.tree's `shallow-copy-statement`), then each child field is written into the copy
//   - a `need false` list is rebuilt only when it holds something: Term cannot tell an absent list from an empty one,
//     and writing one would add a key the input did not have (traps.md T003)
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { camel, knownRecords, reachFrom, root, type Field, type Ty } from './node-tree-read'

const known = knownRecords()

// the nodes a child can be, each with its node-handle case (compile/node-children.tree)
const NODES: [string, string, string][] = [
  ['expression', 'expression-handle', 'expression'],
  ['statement', 'statement-handle', 'statement'],
  ['type', 'type-handle', 'type'],
  ['view-node', 'view-handle', 'view'],
]
const NODE_NAMES = new Set(NODES.map(([name]) => name))

// fields node.tree declares that compile/node-children.tree never enters, `record.field`: the step leaves them as they
// were, so a walk handing it node-children's list stays in step. None today: a match arm's `type` was one until item 0830
const NOT_CHILDREN = new Set<string>()

const reached = reachFrom(known, NODES.map(([name]) => name))

// whether a record holds a node at any depth
const holding = new Map<string, boolean>()

function holds(name: string, seen: Set<string> = new Set()): boolean {
  if (NODE_NAMES.has(name)) return true
  const known_ = holding.get(name)
  if (known_ !== undefined) return known_
  if (seen.has(name)) return false
  seen.add(name)
  const record = known.get(name)!
  const fields = [...record.fields.map(f => [record.name, f] as const), ...record.variants.flatMap(v => v.fields.map(f => [record.name, f] as const))]
  const answer = fields.some(([owner, field]) => !NOT_CHILDREN.has(`${owner}.${field.name}`) && tyHolds(field.ty, seen))
  holding.set(name, answer)
  return answer
}

function tyHolds(ty: Ty, seen: Set<string> = new Set()): boolean {
  if (ty.k === 'form') return holds(ty.name, seen)
  if (ty.k === 'list' || ty.k === 'maybe') return tyHolds(ty.of, seen)
  return false
}

function isChild(owner: string, field: Field): boolean {
  return !NOT_CHILDREN.has(`${owner}.${field.name}`) && tyHolds(field.ty)
}

const lines: string[] = []
const put = (line = ''): void => {
  lines.push(line)
}

let counter = 0

// the expression that answers a rebuilt single value of a form: a node is the next child, a record is rebuilt
function single(name: string, read: string): string {
  if (NODE_NAMES.has(name)) return `next-${handleWord(name)}(cursor)`
  return `rebuild-part-${name}(cursor, skip, ${read})`
}

function handleWord(name: string): string {
  return NODES.find(([n]) => n === name)![2]
}

// statements that leave the rebuilt value of `ty` (read from `read`) in a fresh local, whose name is answered
function rebuilt(ty: Ty, read: string, indent: string): string {
  const k = ++counter
  if (ty.k === 'form') {
    const made = `made-${k}`
    put(`${indent}save ${made}, ${single(ty.name, read)}`)
    return made
  }
  if (ty.k === 'list') {
    const made = `made-${k}`
    const one = `one-${k}`
    put(`${indent}save ${made}, make list`)
    put(`${indent}walk ${read}`)
    put(`${indent}  take ${one}`)
    if (ty.of.k === 'form') {
      put(`${indent}  push(${made}, ${single(ty.of.name, one)})`)
    } else {
      const inner = rebuilt(ty.of, one, `${indent}  `)
      put(`${indent}  push(${made}, ${inner})`)
    }
    return made
  }
  throw new Error(`a ${ty.k} inside a list is not one node.tree holds a node in`)
}

// the statements that write one child field into `copy`. `read` is the Term path or local that holds the old value
function writeChild(field: Field, read: string, indent: string): void {
  const key = camel(field.name)
  const ty = field.ty
  const enter = `enters(skip, <${key}>)`

  if (ty.k === 'maybe') {
    const k = ++counter
    put(`${indent}fork test, ${enter}`)
    put(`${indent}  hold`)
    put(`${indent}    save held-${k}, ${read}`)
    put(`${indent}    sift held-${k}`)
    put(`${indent}      case some`)
    put(`${indent}        link inner-${k}`)
    const made = rebuilt(ty.of, `inner-${k}`, `${indent}        `)
    put(`${indent}        save copy/${field.name}, make(some, ${made})`)
    put(`${indent}      case none`)
    put(`${indent}        save ignored-${k}, 0`)
    return
  }

  if (ty.k === 'list' && field.optional) {
    put(`${indent}fork test, and(${enter}, is-above(${read}/length, 0))`)
  } else {
    put(`${indent}fork test, ${enter}`)
  }
  put(`${indent}  hold`)
  const made = rebuilt(ty, read, `${indent}    `)
  put(`${indent}    save copy/${field.name}, ${made}`)
}

// one record's step: a copy, then its child fields written into it. A node takes no cursor of its own children's
// children: they were rebuilt already, and come in as the node's children
function writeRecord(name: string): void {
  const record = known.get(name)!
  const isNode = NODE_NAMES.has(name)
  put(`task ${isNode ? `rebuild-step-${name}` : `rebuild-part-${name}`}`)
  put('  take cursor, like rebuild-cursor')
  put('  take skip, like list, like text')
  put(`  take given, like ${name}`)
  put(`  like ${name}`)
  put('  mark private')
  put('')
  put(`  save copy, node-rebuild-copy-${name}(given)`)
  if (record.variants.length === 0) {
    for (const field of record.fields) if (isChild(name, field)) writeChild(field, `given/${field.name}`, '  ')
  } else {
    const arms = record.variants.filter(v => v.fields.some(f => isChild(name, f)))
    if (arms.length > 0) {
      put('  sift copy')
      for (const variant of arms) {
        put(`    case ${variant.name}`)
        // every field renamed in declaration order: a field named like an outer local would hide it (traps.md T010)
        variant.fields.forEach((_, at) => put(`      link f${at + 1}`))
        variant.fields.forEach((field, at) => {
          if (isChild(name, field)) writeChild(field, `f${at + 1}`, '      ')
        })
      }
      if (arms.length < record.variants.length) {
        put('    miss')
        put('      save nothing, 0')
      }
    }
  }
  put('  back copy')
  put('')
}

function copyBind(name: string): void {
  put(`bind node-rebuild-copy-${name}`)
  put(`  take value, like ${name}`)
  put(`  like ${name}`)
  put('  case node')
  put('    text <(\\{ ...$value \\})>')
  put('  case browser')
  put('    text <(\\{ ...$value \\})>')
  put('  case rust')
  put('    text <$value>')
  put('  case swift')
  put('    text <$value>')
  put('  case kotlin')
  put('    text <$value>')
  put('')
}

function nextTask([name, handle, word]: [string, string, string]): void {
  put(`task next-${word}`)
  put('  take cursor, like rebuild-cursor')
  put(`  like ${name}`)
  put('  mark private')
  put('')
  put('  fork test, is-minimum(cursor/at, cursor/items/length)')
  put('    hold')
  put(`      halt <node-rebuild: a ${word} child was wanted at {cursor/at}, past the {cursor/items/length} children given>`)
  put('  save handle, get(cursor/items, cursor/at)')
  put('  save cursor/at, add(cursor/at, 1)')
  put('  sift handle')
  put(`    case ${handle}`)
  put('      link inner')
  put('      back inner')
  put('    miss')
  put(`      halt <node-rebuild: a ${word} child was wanted at {subtract(cursor/at, 1)}, and another kind of node was given>`)
  put('')
}

const holdingRecords = reached.filter(name => holds(name))

// the nodes that stand at a place (decision 011 rule 2): each case carries `place-row`
const PLACED = ['expression', 'statement']

// one node with its `place-row` set: a fresh shallow copy (the input is never written), the row written into the copy
// in its own case's arm, since a field off a union is written only inside an arm. Every field of the case is renamed
// in declaration order, so no field hides `row` (traps.md T010). A case without `place-row` is answered unstamped
function placeTask(name: string): void {
  const record = known.get(name)!
  const arms = record.variants.filter(v => v.fields.some(f => f.name === 'place-row'))
  put(`# one ${name}, a fresh copy with its \`place-row\` set to \`row\` (decision 011 rule 2). The input is never written`)
  put(`task place-${name}`)
  put(`  take given, like ${name}`)
  put('  take row, like number')
  put(`  like ${name}`)
  put('')
  put(`  save copy, node-rebuild-copy-${name}(given)`)
  if (arms.length > 0) {
    put('  sift copy')
    for (const variant of arms) {
      put(`    case ${variant.name}`)
      variant.fields.forEach((_, at) => put(`      link f${at + 1}`))
      put('      save copy/place-row, row')
    }
    if (arms.length < record.variants.length) {
      put('    miss')
      put('      save nothing, 0')
    }
  }
  put('  back copy')
  put('')
  // the row read back: a field off a union is read only inside an arm too
  put(`# one ${name}'s \`place-row\`, 0 where it was never stamped`)
  put(`task place-row-of-${name}`)
  put(`  take given, like ${name}`)
  put('  like number')
  put('')
  if (arms.length > 0) {
    put('  sift given')
    for (const variant of arms) {
      put(`    case ${variant.name}`)
      variant.fields.forEach((_, at) => put(`      link f${at + 1}`))
      put(`      back f${variant.fields.findIndex(f => f.name === 'place-row') + 1}`)
    }
    if (arms.length < record.variants.length) {
      put('    miss')
      put('      back 0')
    }
  } else {
    put('  back 0')
  }
  put('')
}

function header(): void {
  put('# ONE rebuild step every walk shares (decision 044): given a node and its new children, in the order')
  put('# compile/node-children.tree hands them out, a FRESH parent. GENERATED by task/term/node-rebuild-gen.ts from')
  put('# compile/node.tree: edit the generator, never this file.')
  put('#')
  put('# What it decides:')
  put('#   - the parent is a new node, and every record between it and a child is new too (a branch, a field value, a map')
  put('#     entry, a parameter, a dock\'s parts), each child written where the old one stood. The input is never written')
  put('#   - a key named in `skip` is not entered, at every depth, as node-children does not enter it: the field stays as it')
  put('#     was and takes no child')
  put('#   - a `need false` list is rebuilt only when it holds something, so no key the input lacked is added')
  put('#   - the children must be exactly node-children\'s list: one too few, one too many or one of another kind raises')
  put('#     `failure`, naming where')
  put('#   - `place-expression` and `place-statement` answer a fresh copy of one node with its `place-row` set, and')
  put('#     `place-row-of-expression` and `place-row-of-statement` read it, for compile/place-stamp.tree (decision 011)')
  put('')
  put('load @term/base/list')
  put('  find list')
  put('  find get')
  put('  find contains')
  put('')
  put('load @term/base/maybe')
  put('  find maybe')
  put('')
  put('load ./node')
  for (const name of holdingRecords) put(`  find ${name}`)
  put('')
  put('load ./node-children')
  put('  find node-handle')
  put('')
  put('# the children not yet taken')
  put('form rebuild-cursor')
  put('  mark shared')
  put('  link items, like list, like node-handle')
  put('  link at, like number')
  put('')
  put('# ---- the public steps ----')
  put('')
  put('# a node, rebuilt over its new children (node-children\'s list for the same `skip`), as a handle of the same case')
  put('task rebuild-node')
  put('  take handle, like node-handle')
  put('  take children, like list, like node-handle')
  put('  take skip, like list, like text')
  put('  like node-handle')
  put('')
  put('  save cursor')
  put('    make rebuild-cursor')
  put('      bind items, children')
  put('      bind at, 0')
  put('  save made, rebuild-handle(cursor, skip, handle)')
  put('  finish-rebuild(cursor)')
  put('  back made')
  put('')
  for (const [name, , word] of NODES) {
    put(`# one ${name}, rebuilt over its new children`)
    put(`task rebuild-${word}`)
    put(`  take node, like ${name}`)
    put('  take children, like list, like node-handle')
    put('  take skip, like list, like text')
    put(`  like ${name}`)
    put('')
    put('  save cursor')
    put('    make rebuild-cursor')
    put('      bind items, children')
    put('      bind at, 0')
    put(`  save made, rebuild-step-${name}(cursor, skip, node)`)
    put('  finish-rebuild(cursor)')
    put('  back made')
    put('')
  }
  for (const name of PLACED) placeTask(name)
  put('# ---- the pieces ----')
  put('')
  put('task rebuild-handle')
  put('  take cursor, like rebuild-cursor')
  put('  take skip, like list, like text')
  put('  take handle, like node-handle')
  put('  like node-handle')
  put('  mark private')
  put('')
  put('  sift handle')
  for (const [name, handle] of NODES) {
    put(`    case ${handle}`)
    put('      link inner')
    put(`      save made, rebuild-step-${name}(cursor, skip, inner)`)
    put('      back')
    put(`        make node-handle/${handle}`)
    put('          bind node, made')
  }
  put('')
  put('# every child given was taken')
  put('task finish-rebuild')
  put('  take cursor, like rebuild-cursor')
  put('  like void')
  put('  mark private')
  put('')
  put('  fork test, is-below(cursor/at, cursor/items/length)')
  put('    hold')
  put('      halt <node-rebuild: {cursor/items/length} children were given and {cursor/at} taken>')
  put('')
  put('# whether the key is entered: not named in the skip list')
  put('task enters')
  put('  take skip, like list, like text')
  put('  take key, like text')
  put('  like boolean')
  put('  mark private')
  put('')
  put('  back not(contains(skip, key))')
  put('')
  for (const node of NODES) nextTask(node)
  for (const name of holdingRecords) copyBind(name)
}

// the generation: the records first, then the header and the helpers around them
const bodyStart = lines.length
for (const name of holdingRecords) writeRecord(name)
const body = lines.splice(bodyStart)
header()
for (const line of body) put(line)

const target = join(root, 'compile/node-rebuild.tree')
const text = lines.join('\n').replace(/\n+$/, '\n')

if (process.argv.includes('--check')) {
  let committed = ''
  try {
    committed = readFileSync(target, 'utf8')
  } catch {
    committed = ''
  }
  if (committed === text) {
    console.log(`node-rebuild: ${target} is current (${holdingRecords.length} records)`)
  } else {
    const was = committed.split('\n')
    const now = text.split('\n')
    let at = 0
    while (at < was.length && at < now.length && was[at] === now[at]) at++
    console.log(`node-rebuild: ${target} is STALE against node.tree, first difference at line ${at + 1}`)
    console.log(`  committed: ${was[at] ?? '(end of file)'}`)
    console.log(`  generated: ${now[at] ?? '(end of file)'}`)
    console.log('  regenerate: npx tsx task/term/node-rebuild-gen.ts --write')
    process.exitCode = 1
  }
} else if (process.argv.includes('--write')) {
  writeFileSync(target, text)
  console.log(`wrote ${target}: ${text.split('\n').length} lines, ${holdingRecords.length} records`)
} else if (process.argv.includes('--out')) {
  const out = process.argv[process.argv.indexOf('--out') + 1]!
  writeFileSync(out, text)
  console.log(`wrote ${out}: ${text.split('\n').length} lines, ${holdingRecords.length} records`)
} else {
  console.log(`would write ${target}: ${text.split('\n').length} lines, ${holdingRecords.length} records`)
}
