// Which TypeScript type SHAPES a deck's code uses that a Term `form` cannot spell today, counted per file, so the
// shared-types port (compile/node.ts, engine/ast.ts, Span, Diagnostic) is sized before it starts. Read by the
// TypeScript parser, never by regex.
//
//   pnpm term:type-shapes <deck> [dir]      e.g. pnpm term:type-shapes make engine
//
// The shapes, each with what Term has instead today:
//   literal-union    'a' | 'b' as a type (a closed set of texts). Term: `like text`, which loses the set
//   primitive-union  number | bigint, string | number. Term: none
//   mixed-union      string | Expression, a primitive beside a record in one union. Term: none
//   tag-not-form     a discriminated union whose tag field is not `form` (`kind`, `type`). Term: `form` only (0020)
//   inline-record    an object type literal nested inside another ({ cond; body }[]). Term: a named form

import ts from 'typescript'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const deck = process.argv[2]

if (!deck) {
  console.error('usage: pnpm term:type-shapes <deck> [dir]')
  process.exit(2)
}

const base = join(TERM, 'deck', deck, 'code', process.argv[3] ?? '')

type Shape = 'literal-union' | 'primitive-union' | 'mixed-union' | 'tag-not-form' | 'inline-record'
const SHAPES: Shape[] = ['literal-union', 'primitive-union', 'mixed-union', 'tag-not-form', 'inline-record']

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)

    if (statSync(path).isDirectory()) {
      if (entry !== 'node_modules' && entry !== 'host' && entry !== 'tmp') {
        walk(path, out)
      }
    } else if (path.endsWith('.ts') && !path.endsWith('.d.ts') && !path.endsWith('.generated.ts')) {
      out.push(path)
    }
  }

  return out
}

const PRIMITIVE = new Set([
  ts.SyntaxKind.StringKeyword,
  ts.SyntaxKind.NumberKeyword,
  ts.SyntaxKind.BigIntKeyword,
  ts.SyntaxKind.BooleanKeyword,
])

function isPrimitive(node: ts.TypeNode): boolean {
  return PRIMITIVE.has(node.kind)
}

function isTextLiteral(node: ts.TypeNode): boolean {
  return ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)
}

function isNullish(node: ts.TypeNode): boolean {
  return (
    node.kind === ts.SyntaxKind.UndefinedKeyword ||
    (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)
  )
}

// the tag a union of object literals discriminates on: the one property every member has as a text literal
function tagOf(members: readonly ts.TypeNode[]): string | undefined {
  const records = members.filter(ts.isTypeLiteralNode)

  if (records.length < 2 || records.length !== members.length) {
    return undefined
  }

  const literalProps = (record: ts.TypeLiteralNode): Set<string> =>
    new Set(
      record.members
        .filter(ts.isPropertySignature)
        .filter(prop => prop.type && isTextLiteral(prop.type))
        .map(prop => prop.name.getText()),
    )

  const [first, ...rest] = records.map(literalProps)

  return [...first!].find(name => rest.every(props => props.has(name)))
}

const counts = new Map<string, Record<Shape, number>>()

for (const file of walk(base)) {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true)
  const found: Record<Shape, number> = {
    'literal-union': 0,
    'primitive-union': 0,
    'mixed-union': 0,
    'tag-not-form': 0,
    'inline-record': 0,
  }

  const visit = (node: ts.Node, inRecord: boolean): void => {
    if (ts.isUnionTypeNode(node)) {
      const members = node.types.filter(member => !isNullish(member))
      const literals = members.filter(isTextLiteral).length
      const primitives = members.filter(isPrimitive).length
      const others = members.length - literals - primitives

      if (literals >= 2 && literals === members.length) {
        found['literal-union']++
      } else if (primitives >= 2 && primitives === members.length) {
        found['primitive-union']++
      } else if (primitives >= 1 && others >= 1) {
        found['mixed-union']++
      } else {
        const tag = tagOf(members)

        if (tag && tag !== 'form') {
          found['tag-not-form']++
        }
      }
    }

    // an object type literal inside another object type literal, or as an array element of one
    if (ts.isTypeLiteralNode(node) && inRecord) {
      found['inline-record']++
    }

    const nested = inRecord || ts.isTypeLiteralNode(node)
    ts.forEachChild(node, child => visit(child, nested))
  }

  ts.forEachChild(source, child => visit(child, false))

  if (SHAPES.some(shape => found[shape] > 0)) {
    counts.set(relative(join(TERM, 'deck', deck, 'code'), file), found)
  }
}

const total = Object.fromEntries(SHAPES.map(shape => [shape, 0])) as Record<Shape, number>

for (const found of counts.values()) {
  for (const shape of SHAPES) {
    total[shape] += found[shape]
  }
}

const rows = [...counts.entries()].sort(
  ([, a], [, b]) => SHAPES.reduce((n, s) => n + b[s], 0) - SHAPES.reduce((n, s) => n + a[s], 0),
)

console.log(`term type-shapes: @term/${deck}${process.argv[3] ? `/${process.argv[3]}` : ''}, ${counts.size} files use a shape Term cannot spell`)
console.log(`  ${SHAPES.map(shape => `${shape} ${total[shape]}`).join(', ')}`)
console.log('')

for (const [file, found] of rows.slice(0, 25)) {
  const shown = SHAPES.filter(shape => found[shape] > 0).map(shape => `${shape} ${found[shape]}`)
  console.log(`  ${file.padEnd(40)} ${shown.join(', ')}`)
}

if (rows.length > 25) {
  console.log(`  ... and ${rows.length - 25} more`)
}
