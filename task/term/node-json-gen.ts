// Writes deck/make/code/compile/node-json.tree: the AST as JSON text in node.tree's declared order (item
// term-self-host-001-0031, spec 4.7). The writer is a walk over every record node.tree declares, so it is generated from
// node.tree (and parser/diagnostic.tree's span and position) rather than written by hand a hundred times. Edit THIS file,
// never the .tree.
//
//   npx tsx task/term/node-json-gen.ts [--write | --check]
//
// Without --write it prints how many tasks it would write. --check exits 1 when the committed file differs from what it
// would write (decision 034 §4: a field added to node.tree without regenerating the writer cannot pass). The shape of one record's writer, and the rules it follows:
//   - a record is its members joined by `,` between braces: a union's tag first (`form`, or `kind` under `mark tag`), then
//     every field in the order node.tree declares it. A member whose key is in the skip list is left out WITHOUT its value
//     being visited, as a replacer returning `undefined` does
//   - `need false` is an optional field. A maybe is written when it is `some` and left out when `none`. Any other optional
//     field is left out when it holds its default (false, the empty text, 0, the empty list): Term reads an absent field as the
//     default, so it cannot tell the two apart (traps.md T002 and the note in node-reach.tree)
//   - a text is written by term/quote.tree's `json-quote`, a number as JavaScript prints it (`null` for what JSON cannot
//     write), a text form (`mark text`) as its text
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { camel, knownRecords, reachFrom, root, type Field, type Record, type Ty } from './node-tree-read'

const known = knownRecords()

// the forms the roots reach, in the order they are first met
// (`twin`, decision 039: a node.tree form, so its identity is node-json too)
const roots = ['expression', 'statement', 'view-node', 'type', 'twin']
const reached = reachFrom(known, roots)

// the helpers one list type needs
const listOf = new Set<string>()

function listKey(ty: Ty): string {
  if (ty.k === 'text') return 'text'
  if (ty.k === 'number') return 'number'
  if (ty.k === 'float') return 'float'
  if (ty.k === 'flag') return 'flag'
  if (ty.k === 'form') return ty.name
  throw new Error('a list of lists or maybes is not one node.tree holds')
}

const lines: string[] = []
const put = (line = ''): void => {
  lines.push(line)
}

// the text a value of one type is written as, over the Term expression that reads it
function valueCall(ty: Ty, read: string): string {
  switch (ty.k) {
    case 'text':
      return `json-quote(${read})`
    case 'number':
      return `number-json(${read})`
    case 'float':
      return `float-json(${read})`
    case 'flag':
      return `flag-json(${read})`
    case 'form': {
      const record = known.get(ty.name)!
      return record.text ? `json-of-${ty.name}(${read})` : `json-of-${ty.name}(skip-keys, ${read})`
    }
    case 'list': {
      const key = listKey(ty.of)
      listOf.add(key)
      return ['text', 'number', 'float', 'flag'].includes(key) ? `json-of-${key}-list(${read})` : `json-of-${key}-list(skip-keys, ${read})`
    }
    case 'maybe':
      throw new Error('a maybe is written by its field')
  }
}

let counter = 0

// the statements that write one field into `members`, indented under `indent`. `read` is the Term path or local that
// holds the field's value
function writeField(field: Field, read: string, indent: string, path = read): void {
  const key = camel(field.name)
  const guard = (extra?: string): string => (extra ? `and(enters(skip-keys, <${key}>), ${extra})` : `enters(skip-keys, <${key}>)`)
  const ty = field.ty

  if (ty.k === 'maybe') {
    const held = `held-${++counter}`
    put(`${indent}fork test, enters(skip-keys, <${key}>)`)
    put(`${indent}  hold`)
    put(`${indent}    save ${held}, ${read}`)
    put(`${indent}    sift ${held}`)
    put(`${indent}      case some`)
    put(`${indent}        link inner`)
    put(`${indent}        push(members, <"${key}":{${valueCall(ty.of, 'inner')}}>)`)
    put(`${indent}      case none`)
    put(`${indent}        save ignored, true`)
    return
  }

  if (!field.optional) {
    put(`${indent}fork test, ${guard()}`)
    put(`${indent}  hold`)
    put(`${indent}    push(members, <"${key}":{${valueCall(ty, read)}}>)`)
    return
  }

  // an optional list is walked where it stands: handing it to a task writes an empty list into the input
  // (traps.md T003), and the input must stay as it was
  if (ty.k === 'list') {
    const parts = `parts-${++counter}`
    const one = ty.of.k === 'form' ? (known.get(ty.of.name)!.text ? `json-of-${ty.of.name}(one)` : `json-of-${ty.of.name}(skip-keys, one)`) : valueCall(ty.of, 'one')
    put(`${indent}fork test, ${guard(`is-above(${path}/length, 0)`)}`)
    put(`${indent}  hold`)
    put(`${indent}    save ${parts}, make list`)
    put(`${indent}    walk ${path}`)
    put(`${indent}      take one`)
    put(`${indent}      push(${parts}, ${one})`)
    put(`${indent}    push(members, <"${key}":[{join(${parts}, <,>)}]>)`)
    return
  }

  // an optional field that is not a maybe: left out when it holds its default
  let present: string
  switch (ty.k) {
    case 'text':
      present = `is-unequal(${read}, <>)`
      break
    case 'flag':
      present = read
      break
    // an optional number reads 0 when absent (D10, `place-row`), so 0 is left out (decision 044 part 3)
    case 'number':
      present = `is-unequal(${read}, 0)`
      break
    case 'list':
      present = `is-above(${read}/length, 0)`
      break
    default:
      throw new Error(`an optional ${ty.k} field (${field.name}) has no default to leave out`)
  }
  put(`${indent}fork test, ${guard(present)}`)
  put(`${indent}  hold`)
  put(`${indent}    push(members, <"${key}":{${valueCall(ty, read)}}>)`)
}

function header(): void {
  put('# The AST as JSON text, in the order node.tree declares each record\'s fields: what `JSON.stringify(node, replacer)` wrote')
  put('# where the object\'s keys were in that order (item term-self-host-001-0031, spec 4.7). GENERATED by task/term/node-json-gen.ts')
  put('# from compile/node.tree and parser/diagnostic.tree: edit the generator, never this file.')
  put('#')
  put('# What it decides:')
  put('#   - the writer never reads key order from the object: it walks node.tree\'s declaration, a union\'s tag (`form`, or `kind`')
  put('#     under `mark tag`) first. A node built with its keys in another order writes the same text here, which is the')
  put('#     point (an object built out of declared order is the only difference from JSON.stringify, traps.md T026)')
  put('#   - a SKIP LIST names the keys left out at every depth, spelled as TypeScript spells them (`span`, `valueArgs`), as a')
  put('#     replacer returning `undefined` for them did. A skipped key\'s value is never visited. `place-row` goes in the list')
  put('#     the pipeline\'s fingerprints use, so stamping changes no key')
  put('#   - a `need false` field that is not a maybe is left out when it holds its default (false, the empty text, 0, the')
  put('#     empty list), because Term reads an absent field as that default and cannot tell the two apart. A maybe is written when')
  put('#     it is `some` and left out when `none`')
  put('#   - a text is quoted by term/quote.tree and a number as JavaScript prints it, `null` for what JSON cannot write')
  put('#   - no bigint: node.ts reshaped an integer literal to its number and its `digits`')
  put('')
  put('load @term/base/list')
  put('  find list')
  put('  find join')
  put('  find contains')
  put('')
  put('load @term/base/maybe')
  put('  find maybe')
  put('')
  put('load ../term/quote')
  put('  find json-quote')
  put('')
  put('load ./node')
  for (const name of reached) if (known.get(name)!.file === 'compile/node.tree') put(`  find ${name}`)
  put('')
  put('load ../parser/diagnostic')
  for (const name of reached) if (known.get(name)!.file === 'parser/diagnostic.tree') put(`  find ${name}`)
  put('')
  put('# ---- the public writers ----')
  put('')
  put('# an expression as JSON, with the keys in `skip` left out at every depth')
  put('task expression-json')
  put('  take skip, like list, like text')
  put('  take node, like expression')
  put('  like text')
  put('')
  put('  back json-of-expression(skip, node)')
  put('')
  put('# a statement as JSON')
  put('task statement-json')
  put('  take skip, like list, like text')
  put('  take node, like statement')
  put('  like text')
  put('')
  put('  back json-of-statement(skip, node)')
  put('')
  put('# a view node as JSON')
  put('task view-json')
  put('  take skip, like list, like text')
  put('  take node, like view-node')
  put('  like text')
  put('')
  put('  back json-of-view-node(skip, node)')
  put('')
  put('# a type as JSON')
  put('task type-json')
  put('  take skip, like list, like text')
  put('  take node, like type')
  put('  like text')
  put('')
  put('  back json-of-type(skip, node)')
  put('')
  put('# a twin as JSON (decision 039)')
  put('task twin-json')
  put('  take skip, like list, like text')
  put('  take node, like twin')
  put('  like text')
  put('')
  put('  back json-of-twin(skip, node)')
  put('')
  put('# a whole program as JSON')
  put('task program-json')
  put('  take skip, like list, like text')
  put('  take statements, like list, like statement')
  put('  like text')
  put('')
  put('  back json-of-statement-list(skip, statements)')
  put('')
  put('# ---- the pieces ----')
  put('')
  put('# whether the key is written: not named in the skip list')
  put('task enters')
  put('  take skip-keys, like list, like text')
  put('  take key, like text')
  put('  like boolean')
  put('  mark private')
  put('')
  put('  back not(contains(skip-keys, key))')
  put('')
  put('# a number as JSON writes it: what is not finite is `null`')
  put('task number-json')
  put('  take value, like number')
  put('  like text')
  put('  mark private')
  put('')
  put('  back finite-json(<{value}>)')
  put('')
  put('task float-json')
  put('  take value, like float')
  put('  like text')
  put('  mark private')
  put('')
  put('  back finite-json(<{value}>)')
  put('')
  put('task finite-json')
  put('  take written, like text')
  put('  like text')
  put('  mark private')
  put('')
  put('  fork test, is-equal(written, <NaN>)')
  put('    hold')
  put('      back <null>')
  put('  fork test, is-equal(written, <Infinity>)')
  put('    hold')
  put('      back <null>')
  put('  fork test, is-equal(written, <-Infinity>)')
  put('    hold')
  put('      back <null>')
  put('  back written')
  put('')
  put('task flag-json')
  put('  take value, like boolean')
  put('  like text')
  put('  mark private')
  put('')
  put('  fork test, value')
  put('    hold')
  put('      back <true>')
  put('  back <false>')
  put('')
}

function scalarLists(): void {
  const spec: [string, string, string][] = [
    ['text', 'text', 'json-quote(one)'],
    ['number', 'number', 'number-json(one)'],
    ['float', 'float', 'float-json(one)'],
    ['flag', 'boolean', 'flag-json(one)'],
  ]
  for (const [key, like, call] of spec) {
    if (!listOf.has(key)) continue
    put(`task json-of-${key}-list`)
    put('  take items, like list, like ' + like)
    put('  like text')
    put('  mark private')
    put('')
    put('  save parts, make list')
    put('  walk items')
    put('    take one')
    put(`    push(parts, ${call})`)
    put('  back <[{join(parts, <,>)}]>')
    put('')
  }
}

function formList(name: string): void {
  const record = known.get(name)!
  put(`task json-of-${name}-list`)
  put('  take skip-keys, like list, like text')
  put(`  take items, like list, like ${name}`)
  put('  like text')
  put('  mark private')
  put('')
  put('  save parts, make list')
  put('  walk items')
  put('    take one')
  put(`    push(parts, ${record.text ? `json-of-${name}(one)` : `json-of-${name}(skip-keys, one)`})`)
  put('  back <[{join(parts, <,>)}]>')
  put('')
}

function writeRecord(record: Record): void {
  if (record.text) {
    put(`task json-of-${record.name}`)
    put(`  take subject, like ${record.name}`)
    put('  like text')
    put('  mark private')
    put('')
    put('  back json-quote(to-text(subject))')
    put('')
    return
  }
  put(`task json-of-${record.name}`)
  put('  take skip-keys, like list, like text')
  put(`  take subject, like ${record.name}`)
  put('  like text')
  put('  mark private')
  put('')
  put('  save members, make list')
  if (record.variants.length === 0) {
    for (const field of record.fields) writeField(field, `subject/${field.name}`, '  ')
  } else {
    put('  sift subject')
    for (const variant of record.variants) {
      put(`    case ${variant.name}`)
      // the fields are renamed in declaration order (`must`, `down` and `catch` are words a local cannot be, and a field
      // named like an outer name would hide it, traps.md T010). An optional list is only walked and measured, never handed
      // to a task, so reading it as its default writes nothing into the input (traps.md T003)
      variant.fields.forEach((field, at) => put(`      link f${at + 1}`))
      put(`      fork test, enters(skip-keys, <${record.tag}>)`)
      put('        hold')
      put(`          push(members, <"${record.tag}":"${variant.name}">)`)
      variant.fields.forEach((field, at) => writeField(field, `f${at + 1}`, '      '))
    }
  }
  put('  back <\\{{join(members, <,>)}\\}>')
  put('')
}

// the generation: the records first (which settle the list helpers), then the header and the helpers around them
const bodyStart = lines.length
for (const name of reached) writeRecord(known.get(name)!)
const body = lines.splice(bodyStart)
listOf.add('statement')
for (const key of [...listOf]) {
  if (!['text', 'number', 'float', 'flag'].includes(key)) formList(key)
}
const listBody = lines.splice(bodyStart)
header()
scalarLists()
for (const line of [...listBody, ...body]) put(line)

const target = join(root, 'compile/node-json.tree')
const text = lines.join('\n').replace(/\n+$/, '\n')

if (process.argv.includes('--check')) {
  // stale against node.tree (a field declared without regenerating the writer) exits 1, naming the first differing line
  const committed = readFileSync(target, 'utf8')
  if (committed === text) {
    console.log(`node-json: ${target} is current (${reached.length} records)`)
  } else {
    const was = committed.split('\n')
    const now = text.split('\n')
    let at = 0
    while (at < was.length && at < now.length && was[at] === now[at]) at++
    console.log(`node-json: ${target} is STALE against node.tree, first difference at line ${at + 1}`)
    console.log(`  committed: ${was[at] ?? '(end of file)'}`)
    console.log(`  generated: ${now[at] ?? '(end of file)'}`)
    console.log('  regenerate: npx tsx task/term/node-json-gen.ts --write')
    process.exitCode = 1
  }
} else if (process.argv.includes('--write')) {
  writeFileSync(target, text)
  console.log(`wrote ${target}: ${text.split('\n').length} lines, ${reached.length} records`)
} else if (process.argv.includes('--out')) {
  // a draft outside the tree, for a probe build before the lock window (procedure.md Stage 3, step 2)
  const out = process.argv[process.argv.indexOf('--out') + 1]
  writeFileSync(out, text)
  console.log(`wrote ${out}: ${text.split('\n').length} lines, ${reached.length} records`)
} else {
  console.log(`would write ${target}: ${text.split('\n').length} lines, ${reached.length} records`)
}
