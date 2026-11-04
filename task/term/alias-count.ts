// How much of a deck's TypeScript writes through an ALIAS, which is what D1 (values, note/project/term/self-host/11-decisions.md)
// changes the meaning of (self-hosting-0027).
//
// Under values, writing a LOCAL list or map is unaffected. What changes is a write the caller or another holder was
// meant to see:
//
//   param    a mutating call or an assignment through a parameter (`out.push(x)`, `seen.add(n)`, `node.type = t`)
//   field    the same through a field of something (`this.cache.set(k, v)`, `ctx.out.push(x)`)
//   module   the same through a module-level binding (`REGISTRY.set(k, v)`)
//
// Each is a place a port either returns the value, or declares the form `mark shared`. The count is syntactic: a
// write through a parameter whose caller never reads it again is still counted, so it is an upper bound on the work,
// never an under-count. It sizes each port chunk's D1 cost before the chunk starts, the way port-order sizes lines.
//
//   pnpm term:alias-count make            every file of @term/make, worst first
//   pnpm term:alias-count make check/     one directory

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { TERM_ROOT } from './root'

// run from the repository root, the way `pnpm term:alias-count` runs it
const HOME = TERM_ROOT
const DECKS = join(TERM_ROOT, 'deck')

const argv = process.argv.slice(2).filter(a => !a.startsWith('--'))
const deck = argv[0]
const under = argv[1] ?? ''

if (!deck) {
  console.error('usage: pnpm term:alias-count <deck> [subdirectory]')
  process.exit(2)
}

const CODE = join(DECKS, deck, 'code')

// the methods that change their receiver: arrays, maps and sets
const MUTATORS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
  'set', 'delete', 'clear', 'add',
])

type Kind = 'param' | 'field' | 'module'
type Tally = Record<Kind, number>

function files(dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    if (['node_modules', 'host', 'tmp', '.base'].includes(name)) {
      continue
    }

    const full = join(dir, name)

    if (statSync(full).isDirectory()) {
      files(full, out)
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts') && !name.includes('.generated.')) {
      out.push(full)
    }
  }
}

// the names a function binds as parameters, destructuring included
function paramNames(fn: ts.SignatureDeclaration): Set<string> {
  const names = new Set<string>()

  const add = (binding: ts.BindingName): void => {
    if (ts.isIdentifier(binding)) {
      names.add(binding.text)
    } else {
      for (const element of binding.elements) {
        if (!ts.isOmittedExpression(element)) {
          add(element.name)
        }
      }
    }
  }

  for (const param of fn.parameters) {
    add(param.name)
  }

  return names
}

// the innermost-first chain of enclosing functions' parameters, and whether a name is declared locally in any of them
function classify(receiver: ts.Expression, moduleNames: Set<string>): Kind | undefined {
  // `a.b.push(...)`, `this.x.set(...)`, `a[i].push(...)`: a write through a field
  if (ts.isPropertyAccessExpression(receiver) || ts.isElementAccessExpression(receiver)) {
    return 'field'
  }

  if (!ts.isIdentifier(receiver)) {
    return undefined
  }

  const name = receiver.text

  for (let at: ts.Node | undefined = receiver.parent; at; at = at.parent) {
    if (ts.isFunctionLike(at)) {
      if (paramNames(at).has(name)) {
        return 'param'
      }
    }
  }

  return moduleNames.has(name) ? 'module' : undefined
}

// the names bound at the top of a module (const, let, var), which a function writing them writes module state
function moduleNamesOf(source: ts.SourceFile): Set<string> {
  const names = new Set<string>()

  for (const statement of source.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          names.add(declaration.name.text)
        }
      }
    }
  }

  return names
}

function count(file: string): Tally {
  const text = readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const moduleNames = moduleNamesOf(source)
  const tally: Tally = { param: 0, field: 0, module: 0 }

  const insideFunction = (node: ts.Node): boolean => {
    for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
      if (ts.isFunctionLike(at)) {
        return true
      }
    }

    return false
  }

  const visit = (node: ts.Node): void => {
    // a mutating method call: `x.push(...)`
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      MUTATORS.has(node.expression.name.text) &&
      insideFunction(node)
    ) {
      const kind = classify(node.expression.expression, moduleNames)

      if (kind) {
        tally[kind]++
      }
    }

    // an assignment into something: `x.y = v`, `x[i] = v`, `x.y += v`
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
      (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
      insideFunction(node)
    ) {
      const kind = classify(node.left.expression, moduleNames)

      if (kind) {
        tally[kind]++
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(source)

  return tally
}

function main(): void {
  const all: string[] = []
  files(join(CODE, under), all)

  const rows = all
    .map(file => ({ file: relative(CODE, file), tally: count(file) }))
    .map(row => ({ ...row, total: row.tally.param + row.tally.field + row.tally.module }))
    .sort((a, b) => b.total - a.total || a.file.localeCompare(b.file))

  const sum: Tally = { param: 0, field: 0, module: 0 }

  for (const row of rows) {
    sum.param += row.tally.param
    sum.field += row.tally.field
    sum.module += row.tally.module
  }

  const clean = rows.filter(row => row.total === 0).length

  console.log(`term alias-count: @term/${deck}/code/${under}, ${rows.length} files`)
  console.log(`  writes through a parameter ${sum.param}, a field ${sum.field}, a module binding ${sum.module}`)
  console.log(`  ${clean} files write through no alias at all, and port under D1 with no change`)
  console.log('')
  console.log(`  ${'param'.padStart(6)} ${'field'.padStart(6)} ${'module'.padStart(6)}  file`)

  for (const row of rows.filter(row => row.total > 0)) {
    console.log(
      `  ${String(row.tally.param).padStart(6)} ${String(row.tally.field).padStart(6)} ${String(row.tally.module).padStart(6)}  ${row.file}`,
    )
  }
}

main()
