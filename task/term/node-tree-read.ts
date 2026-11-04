// Reads the records compile/node.tree and parser/diagnostic.tree declare, for the generators that write a walk over
// every one of them: node-json-gen.ts (compile/node-json.tree) and node-rebuild-gen.ts (compile/node-rebuild.tree,
// decision 044). One reader, so the generated files agree on what node.tree declares.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'

export type Ty =
  | { k: 'text' }
  | { k: 'number' }
  | { k: 'float' }
  | { k: 'flag' }
  | { k: 'form'; name: string }
  | { k: 'list'; of: Ty }
  | { k: 'maybe'; of: Ty }

export type Field = { name: string; ty: Ty; optional: boolean }
export type Variant = { name: string; fields: Field[]; text?: string }
export type Record = { name: string; tag: string; text: boolean; fields: Field[]; variants: Variant[]; alias: boolean; file: string }

// the compiler's source root, relative to the Term package root the generators run in
export const root = 'deck/make/code'

function typeOf(raw: any): Ty {
  switch (raw.kind) {
    case 'string':
      return { k: 'text' }
    case 'number':
      return { k: 'number' }
    case 'float':
      return { k: 'float' }
    case 'boolean':
      return { k: 'flag' }
    case 'array':
      return { k: 'list', of: typeOf(raw.element) }
    case 'named':
      if (raw.name === 'maybe') return { k: 'maybe', of: typeOf(raw.args[0]) }
      return { k: 'form', name: raw.name }
    default:
      throw new Error(`type ${raw.kind} is not one node.tree uses`)
  }
}

function fieldOf(raw: any): Field {
  return { name: raw.name, ty: typeOf(raw.type), optional: raw.optional === true }
}

export function read(file: string): Map<string, Record> {
  const path = join(root, file)
  const parsed = parse({ file: path, text: readFileSync(path, 'utf8') })
  if (!parsed.ok) throw new Error(`${path} does not parse`)
  const built = mill(parsed.tree, path)
  if (!built.ok) throw new Error(`${path} does not mill`)
  const out = new Map<string, Record>()
  for (const statement of built.program as any[]) {
    if (statement.form !== 'record-type') continue
    out.set(statement.name, {
      name: statement.name,
      // an empty tag is no `mark tag` (decision 034 section 2: absent and the default read as one), as the mill may
      // write it either way
      tag: statement.tag || 'form',
      text: statement.text === true,
      fields: statement.fields.map(fieldOf),
      variants: statement.variants.map((v: any) => ({ name: v.name, fields: v.fields.map(fieldOf), text: v.text })),
      alias: statement.alias !== undefined,
      file,
    })
  }
  return out
}

// every record node.tree and parser/diagnostic.tree declare, by name
export function knownRecords(): Map<string, Record> {
  return new Map<string, Record>([...read('compile/node.tree'), ...read('parser/diagnostic.tree')])
}

// a field name as TypeScript spells it (`value-args` is `valueArgs`)
export function camel(name: string): string {
  return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
}

// the forms the roots reach, in the order they are first met
export function reachFrom(known: Map<string, Record>, roots: string[]): string[] {
  const reached: string[] = []
  const reach = (name: string): void => {
    if (reached.includes(name)) return
    const record = known.get(name)
    if (!record) throw new Error(`no form ${name}`)
    reached.push(name)
    const visit = (ty: Ty): void => {
      if (ty.k === 'form') reach(ty.name)
      else if (ty.k === 'list' || ty.k === 'maybe') visit(ty.of)
    }
    for (const field of record.fields) visit(field.ty)
    for (const variant of record.variants) for (const field of variant.fields) visit(field.ty)
  }
  for (const name of roots) reach(name)
  return reached
}
