// What every test/**/*.ts asks of a compile and of a run, by AST, per batch of finding/suite-batches.json. Item 0815.
//   node task/term/suite-census.mjs <out.json>   writes the census there, prints a summary
import { createRequire } from 'node:module'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { TERM_ROOT, parentRoot } from './root.ts'

const require = createRequire(`${parentRoot()}/package.json`)
const ts = require('typescript')
const term = TERM_ROOT
const outFile = process.argv[2]

if (!outFile) {
  console.error('usage: suite-census.mjs <out.json>')
  process.exit(2)
}

const batches = JSON.parse(readFileSync(`${parentRoot()}/note/project/term/self-host/change/001-finish-self-host/finding/suite-batches.json`, 'utf8')).batch
const batchOf = new Map()
for (const b of batches) for (const f of b.files) batchOf.set(f, b.id)

const files = []
const walk = d => {
  for (const name of readdirSync(d)) {
    if (name === 'node_modules' || name === 'host' || name === '.base') continue
    const p = join(d, name)
    const s = statSync(p)
    if (s.isDirectory()) walk(p)
    else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) files.push(p)
  }
}
walk(`${term}/test`)
// a batch also holds suites under deck/<package>/test
for (const f of batchOf.keys()) if (!files.includes(`${term}/${f}`)) files.push(`${term}/${f}`)

const asks = new Map()
const ask = (key, rel) => {
  if (!asks.has(key)) asks.set(key, new Set())
  asks.get(key).add(rel)
}
const COMPILERS = new Set(['compile'])

for (const path of files) {
  const rel = relative(term, path)
  const source = readFileSync(path, 'utf8')
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true)
  const text = n => n.getText(sf)
  const top = new Map()
  const locals = new Map()
  const compileVars = new Set()
  const compileHelpers = new Set()
  let importsCompile = false

  // every const of the file by name, the last seen: enough to see through a local
  const gather = n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) locals.set(n.name.text, n.initializer)
    if (ts.isFunctionDeclaration(n) && n.name) top.set(n.name.text, n)
    ts.forEachChild(n, gather)
  }
  gather(sf)

  const see = n => {
    while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression
    if (n && ts.isIdentifier(n) && locals.has(n.text)) return see(locals.get(n.text))
    return n
  }

  const isCompile = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (COMPILERS.has(n.expression.text) || compileHelpers.has(n.expression.text))
  const isDriver = n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && COMPILERS.has(n.expression.text)

  // imports
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st)) continue
    const from = st.moduleSpecifier.text
    if (st.importClause?.isTypeOnly) continue
    const names = []
    const nb = st.importClause?.namedBindings
    if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) if (!e.isTypeOnly) names.push((e.propertyName ?? e.name).text)
    if (nb && ts.isNamespaceImport(nb)) names.push('*')
    if (st.importClause?.name) names.push('default')
    if (from === '@term/make/code/compile/compile' && names.includes('compile')) importsCompile = true
    const pack = /^@term\/|^@cluesurf\//.test(from) ? 'term' : /^node:/.test(from) ? 'node' : /^\./.test(from) ? 'rel' : 'pkg'
    ask(`import-module ${pack} ${from}`, rel)
    for (const name of names) if (pack === 'term' || pack === 'rel') ask(`import ${from} ${name}`, rel)
  }

  // a helper whose body hands back a compile, once round (twice for a helper over a helper)
  for (let round = 0; round < 2; round++) {
    const helpers = n => {
      let name
      let body
      if (ts.isFunctionDeclaration(n) && n.name) { name = n.name.text; body = n.body }
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) { name = n.name.text; body = n.initializer.body }
      if (name && body) {
        let answers = false
        const v = at => {
          if (ts.isReturnStatement(at) && at.expression && isCompile(see(at.expression) ?? at.expression)) answers = true
          ts.forEachChild(at, v)
        }
        if (ts.isBlock(body)) v(body)
        else if (isCompile(body)) answers = true
        if (answers) compileHelpers.add(name)
      }
      ts.forEachChild(n, helpers)
    }
    helpers(sf)
  }

  // vars bound to a compile
  const vars = n => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isCompile(see(n.initializer) ?? n.initializer)) compileVars.add(n.name.text)
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer && isCompile(n.initializer)) {
      for (const e of n.name.elements) ask(`result-field ${(e.propertyName ?? e.name).getText(sf)}`, rel)
    }
    ts.forEachChild(n, vars)
  }
  vars(sf)

  const resolverKind = value => {
    const at = see(value)
    if (!at) return 'unreadable'
    if (ts.isCallExpression(at)) {
      const callee = text(at.expression)
      if (callee === 'withNativeEnv') {
        const inner = at.arguments[1] ? see(at.arguments[1]) : undefined
        const innerName = inner && ts.isCallExpression(inner) ? text(inner.expression) : inner ? ts.SyntaxKind[inner.kind] : '?'
        return `withNativeEnv(${innerName})`
      }
      return `${callee}()`
    }
    if (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) return 'a function literal'
    if (ts.isIdentifier(at)) return top.has(at.text) ? 'a function of the file' : 'a parameter or import'
    return ts.SyntaxKind[at.kind]
  }

  const options = (arg, depth = 0) => {
    const at = see(arg)
    if (!at) return
    if (ts.isObjectLiteralExpression(at)) {
      for (const p of at.properties) {
        if (ts.isSpreadAssignment(p)) { ask('option ...spread', rel); if (depth < 3) options(p.expression, depth + 1); continue }
        const name = p.name?.getText(sf) ?? '?'
        ask(`option ${name}`, rel)
        const value = ts.isPropertyAssignment(p) ? p.initializer : ts.isShorthandPropertyAssignment(p) ? p.name : undefined
        if (name === 'resolve' && value) ask(`resolver ${resolverKind(value)}`, rel)
        if (name === 'leanOf' && value) {
          const v = see(value)
          ask(`leanOf ${v && (ts.isArrowFunction(v) && /true/.test(text(v))) ? '() => true' : v && ts.isCallExpression(v) ? text(v.expression) + '()' : 'another'}`, rel)
        }
        if (name === 'env' && value) {
          const v = see(value)
          ask(`env ${v && ts.isStringLiteralLike(v) ? v.text : 'computed'}`, rel)
        }
      }
    } else {
      ask(`option a value not read: ${ts.SyntaxKind[at.kind]}`, rel)
    }
  }

  const sourceArg = arg => {
    const at = see(arg)
    if (!at) return
    if (ts.isObjectLiteralExpression(at)) {
      for (const p of at.properties) {
        const name = p.name?.getText(sf) ?? '...'
        ask(`source ${name}`, rel)
      }
    } else ask(`source a value not read`, rel)
  }

  const visit = n => {
    // the driver
    if (isDriver(n)) {
      ask('asks compile', rel)
      if (n.arguments[0]) sourceArg(n.arguments[0])
      if (n.arguments[1]) options(n.arguments[1])
    }
    // reads off a compile
    if (ts.isPropertyAccessExpression(n)) {
      const base = n.expression
      const fromVar = ts.isIdentifier(base) && compileVars.has(base.text)
      const fromCall = isCompile(base)
      if (fromVar || fromCall) {
        ask(`result-field ${n.name.text}`, rel)
        // the next read: r.diagnostics.map(d => d.x), r.warnings.some(...), r.obligations.total
        const up = n.parent
        if (ts.isPropertyAccessExpression(up) && up.expression === n) {
          ask(`result-field ${n.name.text}.${up.name.text}`, rel)
          const call = up.parent
          if (ts.isCallExpression(call) && call.expression === up) {
            const arrow = call.arguments[0]
            if (arrow && ts.isArrowFunction(arrow) && arrow.parameters[0] && ts.isIdentifier(arrow.parameters[0].name)) {
              const param = arrow.parameters[0].name.text
              const v = at => {
                if (ts.isPropertyAccessExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === param) ask(`element ${n.name.text}[].${at.name.text}`, rel)
                ts.forEachChild(at, v)
              }
              v(arrow.body)
            }
          }
        }
        if (ts.isElementAccessExpression(up) && up.expression === n) {
          const u2 = up.parent
          if (ts.isPropertyAccessExpression(u2)) ask(`element ${n.name.text}[].${u2.name.text}`, rel)
        }
        // what `.program` goes to
        if (n.name.text === 'program' && ts.isCallExpression(up)) ask(`program goes to ${text(up.expression)}`, rel)
        if (n.name.text === 'typescript' && ts.isCallExpression(up)) ask(`typescript goes to ${text(up.expression)}`, rel)
      }
    }
    if (ts.isCallExpression(n)) {
      const callee = text(n.expression)
      if (/^(spawnSync|spawn|execSync|execFileSync|execFile|exec|fork)$/.test(callee)) {
        const first = n.arguments[0] ? see(n.arguments[0]) : undefined
        const word = first && ts.isStringLiteralLike(first) ? first.text.split(' ')[0] : first ? (ts.isIdentifier(first) ? first.text : 'computed') : '?'
        ask(`run ${callee} ${word}`, rel)
        ask(`run a child`, rel)
        const bag = n.arguments[n.arguments.length - 1]
        const opts = bag ? see(bag) : undefined
        if (opts && ts.isObjectLiteralExpression(opts)) for (const p of opts.properties) ask(`child-option ${p.name?.getText(sf) ?? '...'}`, rel)
      }
      if (n.arguments.length && /^(emitRust|emitSwift|emitKotlin|emitTypeScript)$/.test(callee)) ask('emit any of the four', rel)
      if (callee === 'nativePrelude') ask('prelude nativePrelude', rel)
      if (callee === 'hoistKotlinImports' || callee === 'nativeMain' || callee === 'cratesNamed') ask(`native-run ${callee}`, rel)
      if (callee === 'transformSync' || callee === 'transform' || callee === 'buildSync') ask(`run esbuild ${callee}`, rel)
      if (callee === 'import' ) ask('run dynamic import()', rel)
      if (/^(Date\.now|performance\.now|process\.hrtime(\.bigint)?)$/.test(callee)) ask(`time ${callee}`, rel)
      if (/^(mkdtempSync|tempDir|runDir|removeAtExit|mkdirSync|writeFileSync|readFileSync|rmSync|existsSync|readdirSync|fetch|createServer)$/.test(callee)) ask(`host ${callee}`, rel)
      if (/^(emit[A-Z]\w*|lower\w*|generate\w*|runOn|runText|buildOn|buildText|typecheck\w*|analyze\w*|compileProject\w*|compileSeparate\w*|checkProgram\w*|build\w*)$/.test(callee)) ask(`call ${callee}`, rel)
      if (/^(test|describe|it|expect)$/.test(callee)) ask(`idiom ${callee}`, rel)
    }
    if (ts.isNewExpression(n)) {
      const callee = text(n.expression)
      if (/^(Function|Worker|AsyncFunction|Module|URL)$/.test(callee)) ask(`run new ${callee}`, rel)
    }
    if (ts.isPropertyAccessExpression(n) && text(n.expression) === 'process.env') ask(`process.env ${n.name.text}`, rel)
    if (ts.isElementAccessExpression(n) && text(n.expression) === 'process.env') ask(`process.env [${text(n.argumentExpression)}]`, rel)
    if (ts.isAwaitExpression(n)) ask('asks await', rel)
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) ask('run dynamic import()', rel)
    ts.forEachChild(n, visit)
  }
  visit(sf)
  void importsCompile
}

const out = {}
const row = key => {
  const set = asks.get(key)
  const by = new Map()
  for (const f of set) {
    const b = batchOf.get(f) ?? '(no batch)'
    by.set(b, (by.get(b) ?? 0) + 1)
  }
  return { files: set.size, batches: Object.fromEntries([...by].sort()), sample: [...set].slice(0, 4) }
}
for (const key of [...asks.keys()].sort()) out[key] = row(key)
writeFileSync(outFile,JSON.stringify({ total: files.length, inBatch: files.filter(f => batchOf.has(relative(term, f))).length, asks: out }, null, 1))

const short = key => {
  const r = out[key]
  const ids = Object.keys(r.batches)
  return `${String(r.files).padStart(4)}  b=${String(ids.length).padStart(3)}  ${key}  [${ids.slice(0, 6).join(' ')}${ids.length > 6 ? ' ...' : ''}]`
}
console.log(`files ${files.length}, in a batch ${files.filter(f => batchOf.has(relative(term, f))).length}, batches ${batches.length}`)
const groups = ['asks', 'emit', 'prelude', 'native-run', 'child-option', 'source', 'option', 'resolver', 'leanOf', 'result-field', 'element', 'program goes', 'typescript goes', 'run', 'call', 'time', 'process.env', 'idiom']
for (const g of groups) {
  console.log(`--- ${g}`)
  for (const key of Object.keys(out).filter(k => k.startsWith(g + ' ')).sort((a, b) => out[b].files - out[a].files)) console.log(short(key))
}
console.log('--- imports of the compiler and the CLI, three files or more')
for (const key of Object.keys(out).filter(k => /^import @term\/(make|call)/.test(k) && out[k].files >= 3).sort((a, b) => out[b].files - out[a].files)) console.log(short(key))
