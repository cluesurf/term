// A TypeScript test suite to a lean Term test, as far as the idiom goes (decision 104 "Shapes"). It knows the test idiom
// only: the preamble, ok/expect wrappers, fixtures, compile() and a few common calls. Anything else is written as
// `# PORT:` lines beside a `want hold, false`, so an unfinished test fails instead of passing. One file per run.
//
//   node node_modules/tsx/dist/cli.mjs task/term/suite-port.ts <file.ts> [--out <file.tree>] [--commit] [--json]
//
// Reports by default. --commit writes <file stem>.tree beside the suite and refuses to overwrite one: a finished port
// holds a hand pass this tool cannot redo. --out names a scratch file instead, which it does overwrite.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const NOPE = Symbol('nope')

// where a scope keeps the value process.env.TERM_PROOF_BUDGET holds at that point of the suite
const BUDGET = '@budget'
const BUDGET_TEXT = 'process.env.TERM_PROOF_BUDGET'

class Port extends Error {
  constructor(
    public reason: string,
    public at: ts.Node[] = [],
  ) {
    super(reason)
  }
}

type Bound = {
  value?: unknown
  hasValue?: boolean
  node?: ts.Expression
  env?: Env
  stmt?: ts.Node
  param?: boolean
  host?: string
}

class Env {
  vars = new Map<string, Bound>()
  taint?: string

  constructor(public parent?: Env) {}

  get(name: string): Bound | undefined {
    return this.vars.get(name) ?? this.parent?.get(name)
  }

  tainted(): string | undefined {
    return this.taint ?? this.parent?.tainted()
  }
}

// the fields of compile-choice a `resolve:` comes to (test/support/compiling.tree)
type ResolverChoice = {
  stdlib?: string
  project?: string
  projectEnv?: string
  projectLink?: string
  files?: string
  closed?: boolean
}

type Fn = {
  params: readonly ts.ParameterDeclaration[]
  body: ts.ConciseBody
  node: ts.Node
}

type Ctx = {
  hosts: string[]
  named: Map<string, Bound>
}

const RESERVED = new Set(
  'back bind call case code dock find fold fork form halt head hold host link list load like make mark miss note read role rule save seat seek show sift site task test text tick turn view wait walk want'.split(
    ' ',
  ),
)

const kebab = (name: string): string => {
  const out = name
    .replace(/_/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()

  return RESERVED.has(out) ? `${out}-text` : out
}

const escapeText = (text: string): string =>
  text
    .replace(/\\/g, '\\\\')
    .replace(/</g, '\\<')
    .replace(/>/g, '\\>')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')

class Converter {
  sf: ts.SourceFile
  lines: string[]
  top = new Env()
  fns = new Map<string, Fn>()
  decls = new Map<string, ts.Node>()
  fixtureTasks = new Map<string, string>()
  textHosts = new Set<string>()
  uses = new Set<string>()
  body: string[] = []
  portedDecls: string[] = []
  portedLines = new Set<number>()
  portedDeclNames = new Set<string>()
  reasons = new Map<string, number>()
  tests = 0
  portTests = 0
  portWants = 0
  wants = 0

  constructor(
    public file: string,
    public source: string,
  ) {
    this.sf = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
    )
    this.lines = source.split('\n')
  }

  text(node: ts.Node): string {
    return node.getText(this.sf)
  }

  span(node: ts.Node): number[] {
    const a = this.sf.getLineAndCharacterOfPosition(
      node.getStart(this.sf),
    ).line
    const b = this.sf.getLineAndCharacterOfPosition(node.getEnd()).line
    const out: number[] = []

    for (let i = a; i <= b; i++) out.push(i)

    return out
  }

  // ---- what the file declares ----

  fnOf(node: ts.Node): Fn | undefined {
    if (ts.isFunctionDeclaration(node) && node.body) {
      return { params: node.parameters, body: node.body, node }
    }

    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1
    ) {
      const init = node.declarationList.declarations[0]!.initializer

      if (
        init &&
        (ts.isArrowFunction(init) || ts.isFunctionExpression(init))
      ) {
        return { params: init.parameters, body: init.body, node }
      }
    }

    return undefined
  }

  // a function that counts: its body moves pass or fail
  isCounter(fn: Fn): boolean {
    return /\b(pass|fail)(\+\+|\s*\+=)/.test(this.text(fn.body))
  }

  // a function whose body reaches a counter
  isWrapper(fn: Fn, seen = new Set<Fn>()): boolean {
    if (seen.has(fn)) return false

    seen.add(fn)

    let found = false
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const callee = this.fns.get(node.expression.text)

        if (
          callee &&
          (this.isCounter(callee) || this.isWrapper(callee, seen))
        ) {
          found = true
        }
      }

      ts.forEachChild(node, visit)
    }

    visit(fn.body)

    return found
  }

  // ---- folding: a value known without running the suite ----

  fold(node: ts.Expression, env: Env): unknown {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      return node.text
    }

    if (ts.isNumericLiteral(node)) return Number(node.text)

    if (node.kind === ts.SyntaxKind.TrueKeyword) return true

    if (node.kind === ts.SyntaxKind.FalseKeyword) return false

    if (ts.isParenthesizedExpression(node)) {
      return this.fold(node.expression, env)
    }

    if (ts.isAsExpression(node) || ts.isNonNullExpression(node)) {
      return this.fold(node.expression, env)
    }

    if (ts.isIdentifier(node)) {
      if (node.text === 'undefined') return undefined

      const bound = env.get(node.text)

      if (!bound) return NOPE

      if (bound.hasValue) return bound.value

      if (bound.node) return this.fold(bound.node, bound.env!)

      return NOPE
    }

    if (ts.isTemplateExpression(node)) {
      let out = node.head.text

      for (const span of node.templateSpans) {
        const value = this.fold(span.expression, env)

        if (value === NOPE) return NOPE

        out += String(value) + span.literal.text
      }

      return out
    }

    if (ts.isArrayLiteralExpression(node)) {
      const out: unknown[] = []

      for (const el of node.elements) {
        const value = this.fold(el, env)

        if (value === NOPE) return NOPE

        out.push(value)
      }

      return out
    }

    if (
      ts.isBinaryExpression(node) &&
      (node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        node.operatorToken.kind ===
          ts.SyntaxKind.ExclamationEqualsEqualsToken)
    ) {
      const a = this.fold(node.left, env)
      const b = this.fold(node.right, env)

      if (a === NOPE || b === NOPE) return NOPE

      return node.operatorToken.kind ===
        ts.SyntaxKind.EqualsEqualsEqualsToken
        ? a === b
        : a !== b
    }

    if (ts.isCallExpression(node)) {
      // `Object.entries` of a literal record, its values folded
      if (
        this.text(node.expression) === 'Object.entries' &&
        node.arguments.length === 1
      ) {
        const [record, scope] = this.seenThrough(node.arguments[0]!, env)

        if (!ts.isObjectLiteralExpression(record)) return NOPE

        const out: unknown[] = []

        for (const prop of record.properties) {
          if (
            !ts.isPropertyAssignment(prop) ||
            !(
              ts.isStringLiteralLike(prop.name) ||
              ts.isIdentifier(prop.name)
            )
          ) {
            return NOPE
          }

          const value = this.fold(prop.initializer, scope)

          if (value === NOPE) return NOPE

          out.push([prop.name.text, value])
        }

        return out
      }

      if (ts.isPropertyAccessExpression(node.expression)) {
        const method = node.expression.name.text
        const recv = this.fold(node.expression.expression, env)

        if (recv === NOPE) return NOPE

        if (
          method === 'join' &&
          Array.isArray(recv) &&
          node.arguments.length === 1
        ) {
          const by = this.fold(node.arguments[0]!, env)

          return by === NOPE ? NOPE : recv.join(String(by))
        }

        if (
          method === 'map' &&
          Array.isArray(recv) &&
          node.arguments.length === 1
        ) {
          const arrow = node.arguments[0]!

          if (
            !ts.isArrowFunction(arrow) ||
            ts.isBlock(arrow.body) ||
            arrow.parameters.length !== 1
          ) {
            return NOPE
          }

          const out: unknown[] = []

          for (const item of recv) {
            const inner = new Env(env)

            inner.vars.set(arrow.parameters[0]!.name.getText(this.sf), {
              value: item,
              hasValue: true,
            })

            const value = this.fold(arrow.body, inner)

            if (value === NOPE) return NOPE

            out.push(value)
          }

          return out
        }

        return NOPE
      }

      if (ts.isIdentifier(node.expression)) {
        const fn = this.fns.get(node.expression.text)

        if (!fn || ts.isBlock(fn.body)) return NOPE

        const inner = this.bindParams(fn, node.arguments, env)

        return this.fold(fn.body, inner)
      }
    }

    return NOPE
  }

  bindParams(
    fn: Fn,
    args: readonly ts.Expression[],
    env: Env,
  ): Env {
    const inner = new Env(this.top)
    const taint = env.tainted()

    if (taint) inner.taint = taint

    fn.params.forEach((param, at) => {
      const name = param.name.getText(this.sf)
      const arg = args[at]

      if (arg) {
        inner.vars.set(name, { node: arg, env, param: true })
      } else if (param.initializer) {
        inner.vars.set(name, {
          node: param.initializer,
          env: this.top,
          param: true,
        })
      } else {
        inner.vars.set(name, {
          value: undefined,
          hasValue: true,
          param: true,
        })
      }
    })

    return inner
  }

  // ---- a fixture: a text expression, keeping its shared parts by name where it can ----

  fixture(node: ts.Expression, env: Env): string {
    const folded = (): string => {
      const value = this.fold(node, env)

      if (typeof value !== 'string') {
        throw new Port(`a fixture this tool cannot read`, [node])
      }

      return `<${escapeText(value)}>`
    }

    if (ts.isIdentifier(node)) {
      const bound = env.get(node.text)

      if (bound?.host) return bound.host

      if (bound?.node && !bound.hasValue) {
        return this.fixture(bound.node, bound.env!)
      }

      return folded()
    }

    // a real module read from disk: `readFileSync(path, 'utf8')`
    if (
      ts.isCallExpression(node) &&
      /^(fs\.)?readFileSync$/.test(this.text(node.expression)) &&
      node.arguments[0]
    ) {
      const path = this.pathOf(node.arguments[0], env)

      if (path !== undefined) {
        this.uses.add('project-path')
        this.uses.add('file-text')

        return `file-text(project-path(<.>, <${escapeText(path)}>))`
      }
    }

    if (ts.isTemplateExpression(node)) {
      let out = escapeText(node.head.text)

      for (const span of node.templateSpans) {
        const inner = span.expression
        let hole: string | undefined

        if (ts.isIdentifier(inner)) {
          const bound = env.get(inner.text)

          if (bound?.host) hole = `{${bound.host}}`
        }

        if (hole === undefined) {
          const value = this.fold(inner, env)

          if (value === NOPE) {
            throw new Port(`a fixture hole this tool cannot read`, [span])
          }

          hole = escapeText(String(value))
        }

        out += hole + escapeText(span.literal.text)
      }

      return `<${out}>`
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const task = this.fixtureTasks.get(node.expression.text)

      if (task) {
        return `${task}(${node.arguments.map(a => this.fixture(a, env)).join(', ')})`
      }
    }

    return folded()
  }

  // ---- an expression over a compile, as Term ----

  compileCall(node: ts.CallExpression, env: Env): string {
    const taint = env.tainted()

    if (taint) throw new Port(taint, [node])

    const [source, options] = node.arguments

    if (!source || !ts.isObjectLiteralExpression(source)) {
      throw new Port('compile of a value this tool cannot read', [node])
    }

    let text: ts.Expression | undefined
    let fileNode: ts.Expression | undefined

    for (const prop of source.properties) {
      if (ts.isShorthandPropertyAssignment(prop)) {
        if (prop.name.text === 'text') text = prop.name
        else if (prop.name.text === 'file') fileNode = prop.name
      } else if (ts.isPropertyAssignment(prop)) {
        const name = prop.name.getText(this.sf)

        if (name === 'text') text = prop.initializer
        else if (name === 'file') fileNode = prop.initializer
      }
    }

    if (!text) throw new Port('compile with no text', [node])

    const file: unknown = fileNode ? this.fold(fileNode, env) : undefined
    const filePath =
      fileNode && typeof file !== 'string'
        ? this.pathOf(fileNode, env)
        : undefined

    let lean = false
    let target: string | undefined
    const entries: string[] = []
    const more: string[] = []
    const flags: string[] = []
    let resolver: ResolverChoice = {}

    if (options) {
      if (!ts.isObjectLiteralExpression(options)) {
        throw new Port('compile options this tool cannot read', [options])
      }

      // the project lean and role name a root, so the resolver is read first and they are held to it
      for (const prop of options.properties) {
        const value = this.optionValue(prop)

        if (prop.name?.getText(this.sf) === 'resolve' && value) {
          resolver = this.resolverChoice(value, env, node)
        }
      }

      for (const prop of options.properties) {
        const name = prop.name?.getText(this.sf) ?? ''
        const value = this.optionValue(prop)
        const known = value ? this.fold(value, env) : NOPE

        if (name === 'resolve' && value) {
          continue
        } else if (name === 'leanOf' && value) {
          const [at] = this.seenThrough(value, env)

          if (this.projectCall(at, 'projectLeanOf', resolver, env)) {
            flags.push('bind(project-lean, true)')
          } else if (this.answersOnly(at, 'true')) {
            lean = true
          } else {
            throw new Port('compile option leanOf: a function this tool cannot read', [value])
          }
        } else if (name === 'roleOf' && value) {
          const [at] = this.seenThrough(value, env)

          if (this.projectCall(at, 'projectRoleOf', resolver, env)) {
            flags.push('bind(project-role, true)')
          } else if (
            (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
            !at.parameters.length &&
            !ts.isBlock(at.body) &&
            typeof this.fold(at.body, env) === 'string'
          ) {
            more.push(`bind(role, <${escapeText(this.fold(at.body, env) as string)}>)`)
          } else {
            throw new Port('compile option roleOf: a function this tool cannot read', [value])
          }
        } else if (name === 'deckOf' && value && /^projectDeckOf\(\)$/.test(this.text(value))) {
          flags.push('bind(project-deck, true)')
        } else if (name === 'env' && value) {
          target = this.foldedText(value, env, 'compile option env')
        } else if (name === 'entryPoints' && value) {
          const points = this.fold(value, env)

          if (
            !Array.isArray(points) ||
            !points.length ||
            points.some(point => typeof point !== 'string')
          ) {
            throw new Port(
              'compile option entryPoints: a value this tool cannot read',
              [value],
            )
          }

          entries.push(...(points as string[]))
        } else if (name === 'library' && known === true) {
          flags.push('bind(library, true)')
        } else if (name === 'optimize' && known === false) {
          flags.push('bind(optimize, false)')
        } else if (name === 'treeShake' && typeof known === 'boolean') {
          more.push(`bind(tree-shake, <${known}>)`)
        } else if (name === 'roll' && known === true) {
          flags.push('bind(roll, true)')
        } else if (name === 'cover' && known === true) {
          flags.push('bind(cover, true)')
        } else if (name === 'exposeTwins' && known === true) {
          flags.push('bind(expose-twins, true)')
        } else {
          throw new Port(
            `compile option ${name || 'by spread'}: compile-choice does not hold it`,
            [options],
          )
        }
      }
    }

    const budget = this.budgetOf(env, node)
    const fixture = this.fixture(text, env)

    this.uses.add('compile-text')

    const texts: [string, string | undefined][] = [
      ['stdlib', resolver.stdlib],
      ['project', resolver.project],
      ['project-env', resolver.projectEnv],
      ['project-link', resolver.projectLink],
      ['env', target],
      ['entry', entries.length === 1 ? entries[0] : undefined],
      ['budget', budget],
    ]
    const rest = [
      ...texts
        .filter((pair): pair is [string, string] => pair[1] !== undefined)
        .map(([field, value]) => `bind(${field}, <${escapeText(value)}>)`),
      ...(resolver.files ? [`bind(files, ${resolver.files})`] : []),
      ...(resolver.closed ? ['bind(closed, true)'] : []),
      ...(entries.length > 1
        ? [`bind(entries, make list(${entries.map(one => `<${escapeText(one)}>`).join(', ')}))`]
        : []),
      ...more,
      ...flags,
    ]
    const bound: string[] = []

    if (filePath !== undefined) {
      this.uses.add('project-path')
      bound.push(`bind(file, project-path(<.>, <${escapeText(filePath)}>))`)
    }

    if (lean || (typeof file === 'string' && file.includes('/'))) {
      if (filePath === undefined) {
        const name = typeof file === 'string' ? file : 'suite.tree'

        bound.push(`bind(file, <${escapeText(name)}>)`)
      }

      bound.push(`bind(lean, ${lean})`)
    } else if (rest.length && typeof file === 'string') {
      bound.push(`bind(file, <${escapeText(file)}>)`)
    }

    bound.push(...rest)

    if (!bound.length) return `compile-text(${fixture})`

    this.uses.add('compile-choice')

    return `compile-text(${fixture}, make(compile-choice, ${bound.join(', ')}))`
  }

  foldedText(node: ts.Expression, env: Env, what: string): string {
    const value = this.fold(node, env)

    if (typeof value !== 'string') {
      throw new Port(`${what}: a value this tool cannot read`, [node])
    }

    return value
  }

  optionValue(prop: ts.ObjectLiteralElementLike): ts.Expression | undefined {
    if (ts.isPropertyAssignment(prop)) return prop.initializer

    return ts.isShorthandPropertyAssignment(prop) ? prop.name : undefined
  }

  // `() => true`, with any parameters it ignores
  answersOnly(at: ts.Expression, word: string): boolean {
    return (
      (ts.isArrowFunction(at) || ts.isFunctionExpression(at)) &&
      !ts.isBlock(at.body) &&
      this.text(at.body) === word
    )
  }

  // `projectLeanOf(root)` over the root the resolver of this compile names
  projectCall(
    at: ts.Expression,
    callee: string,
    resolver: ResolverChoice,
    env: Env,
  ): boolean {
    if (
      !ts.isCallExpression(at) ||
      this.text(at.expression) !== callee ||
      at.arguments.length !== 1
    ) {
      return false
    }

    return (
      resolver.project !== undefined &&
      this.pathOf(at.arguments[0]!, env) === resolver.project
    )
  }

  // a path relative to where the suite runs, the way the harness resolves `project`, undefined when this tool cannot tell
  pathOf(node: ts.Expression, env: Env): string | undefined {
    const [at, scope] = this.seenThrough(node, env)

    const spelled = this.text(at)

    if (spelled === 'process.cwd()') return '.'

    // the suite's own folder, as a suite is run from the project root
    if (
      spelled === 'import.meta.dirname' ||
      /^(path\.)?dirname\(fileURLToPath\(import\.meta\.url\)\)$/.test(spelled)
    ) {
      return relative(process.cwd(), dirname(resolve(this.file))) || '.'
    }

    const known = this.fold(at, scope)

    if (typeof known === 'string') return known

    if (
      ts.isCallExpression(at) &&
      /^(fs\.)?realpathSync$/.test(this.text(at.expression)) &&
      at.arguments.length === 1
    ) {
      return this.pathOf(at.arguments[0]!, scope)
    }

    if (
      ts.isCallExpression(at) &&
      /^(path\.)?(join|resolve|resolvePath)$/.test(this.text(at.expression))
    ) {
      const parts = at.arguments.map(arg => this.pathOf(arg, scope))

      if (parts.some(part => part === undefined)) return undefined

      return join(...(parts as string[]))
    }

    return undefined
  }

  // what `resolve:` holds, seen through a local: the stdlib or a project under a native env, nothing at all, or a map
  // of fixtures over any of those
  resolverChoice(node: ts.Expression, env: Env, at: ts.Node): ResolverChoice {
    const [value, scope] = this.seenThrough(node, env)
    const cannot = new Port(
      'compile option resolve: a resolver this tool cannot read',
      [node, at],
    )

    if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
      if (this.answersOnly(value, 'undefined')) return { closed: true }

      return this.fixtureResolver(value, scope) ?? this.throwing(cannot)
    }

    if (!ts.isCallExpression(value)) throw cannot

    const callee = this.text(value.expression)

    if (callee === 'projectResolver') {
      const [root, target, link] = value.arguments
      const project = root && this.pathOf(root, scope)

      if (project === undefined) throw cannot

      const choice: ResolverChoice = { project }

      if (target) {
        choice.projectEnv = this.foldedText(target, scope, 'projectResolver env')
      }

      if (link) {
        const linkRoot = this.pathOf(link, scope)

        if (linkRoot === undefined) throw cannot

        choice.projectLink = linkRoot
      }

      return choice
    }

    if (callee === 'withNativeEnv' && value.arguments.length === 2) {
      const native = this.foldedText(value.arguments[0]!, scope, 'compile option resolve')
      const [below, under] = this.seenThrough(value.arguments[1]!, scope)

      if (/^stdlibResolver\(\)!?$/.test(this.text(below))) {
        return { stdlib: native }
      }

      if (ts.isCallExpression(below) && this.text(below.expression) === 'projectResolver') {
        return { ...this.resolverChoice(below, under, at), stdlib: native }
      }
    }

    throw cannot
  }

  throwing(error: Port): never {
    throw error
  }

  // `path => files[path] !== undefined ? { file: <prefix>${path.slice(n)}<suffix>, text: files[path] } : below(path, from)`,
  // the shape most fixture resolvers take. `files` must be a literal record here
  fixtureResolver(
    fn: ts.ArrowFunction | ts.FunctionExpression,
    env: Env,
  ): ResolverChoice | undefined {
    const param = fn.parameters[0]?.name.getText(this.sf)
    const body = fn.body

    if (!param || ts.isBlock(body) || !ts.isConditionalExpression(body)) {
      return undefined
    }

    const test = body.condition

    if (
      !ts.isBinaryExpression(test) ||
      test.operatorToken.kind !== ts.SyntaxKind.ExclamationEqualsEqualsToken ||
      this.text(test.right) !== 'undefined' ||
      !ts.isElementAccessExpression(test.left) ||
      this.text(test.left.argumentExpression).replace(/ as .*$/, '') !== param
    ) {
      return undefined
    }

    const [record, scope] = this.seenThrough(test.left.expression, env)
    const whenTrue = ts.isParenthesizedExpression(body.whenTrue)
      ? body.whenTrue.expression
      : ts.isAsExpression(body.whenTrue)
        ? body.whenTrue.expression
        : body.whenTrue

    if (
      !ts.isObjectLiteralExpression(record) ||
      !ts.isObjectLiteralExpression(whenTrue)
    ) {
      return undefined
    }

    const answer = this.recordField(whenTrue, 'file')

    if (!answer || !ts.isTemplateExpression(answer)) return undefined

    const span = answer.templateSpans[0]!
    const slice = new RegExp(
      `^${param}\\.slice\\('([^']*)'\\.length\\)$`,
    ).exec(this.text(span.expression))

    if (answer.templateSpans.length !== 1 || !slice) return undefined

    const entries: string[] = []

    for (const prop of record.properties) {
      if (!ts.isPropertyAssignment(prop)) return undefined

      const key = ts.isStringLiteralLike(prop.name) ? prop.name.text : undefined

      if (!key?.startsWith(slice[1]!)) return undefined

      const answered = `${answer.head.text}${key.slice(slice[1]!.length)}${span.literal.text}`

      this.uses.add('compiling-source')
      entries.push(
        `make(compiling-source, bind(file, <${escapeText(key)}>), bind(text, ${this.fixture(prop.initializer, scope)}), bind(answer, <${escapeText(answered)}>))`,
      )
    }

    const files = entries.length ? `make list(${entries.join(', ')})` : undefined
    const otherwise = body.whenFalse

    if (this.text(otherwise) === 'undefined') {
      return files ? { files } : { closed: true }
    }

    if (!ts.isCallExpression(otherwise)) return undefined

    const [callee, under] = this.seenThrough(otherwise.expression, env)
    const below = this.resolverChoice(callee, under, otherwise)

    return files ? { ...below, files } : below
  }

  // an expression with the parentheses and the locals taken off
  seenThrough(node: ts.Expression, env: Env): [ts.Expression, Env] {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return this.seenThrough(node.expression, env)
    }

    if (ts.isIdentifier(node)) {
      const bound = env.get(node.text)

      if (bound?.node && !bound.host) {
        return this.seenThrough(bound.node, bound.env!)
      }
    }

    return [node, env]
  }

  // what TERM_PROOF_BUDGET holds at this compile, undefined for the compiler's own
  budgetOf(env: Env, at: ts.Node): string | undefined {
    const bound = env.get(BUDGET)

    if (!bound) return undefined

    const value = bound.hasValue
      ? bound.value
      : this.fold(bound.node!, bound.env!)

    if (value === undefined) return undefined

    if (typeof value === 'string' || typeof value === 'number') {
      return String(value)
    }

    throw new Port('a proof budget this tool cannot read', [at])
  }

  // `process.env.TERM_PROOF_BUDGET = x`, its delete, and the `if (x === undefined) delete, else set` of a helper
  budgetStatement(st: ts.Node, env: Env): boolean {
    const only = (body: ts.Statement): ts.Statement =>
      ts.isBlock(body) && body.statements.length === 1
        ? body.statements[0]!
        : body
    const deletes = (at: ts.Node): boolean =>
      ts.isExpressionStatement(at) &&
      ts.isDeleteExpression(at.expression) &&
      this.text(at.expression.expression) === BUDGET_TEXT
    const assigned = (at: ts.Node): ts.Expression | undefined =>
      ts.isExpressionStatement(at) &&
      ts.isBinaryExpression(at.expression) &&
      at.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      this.text(at.expression.left) === BUDGET_TEXT
        ? at.expression.right
        : undefined

    if (deletes(st)) {
      env.vars.set(BUDGET, { value: undefined, hasValue: true })

      return true
    }

    const set = assigned(st)

    if (set) {
      env.vars.set(BUDGET, { node: set, env })

      return true
    }

    if (ts.isIfStatement(st) && st.elseStatement) {
      const test = st.expression
      const given = assigned(only(st.elseStatement))

      if (
        given &&
        deletes(only(st.thenStatement)) &&
        ts.isBinaryExpression(test) &&
        test.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        this.text(test.right) === 'undefined' &&
        this.text(test.left) === this.text(given)
      ) {
        env.vars.set(BUDGET, { node: given, env })

        return true
      }
    }

    return false
  }

  records = new Map<ts.Node, WeakMap<Env, { record: ts.ObjectLiteralExpression; env: Env }>>()

  // the record a helper answers (its lets, then `return { ... }`), once per call, so its fields share one compile
  recordOf(
    node: ts.Expression,
    env: Env,
  ): { record: ts.ObjectLiteralExpression; env: Env } | undefined {
    const [at, scope] = this.seenThrough(node, env)

    if (!ts.isCallExpression(at) || !ts.isIdentifier(at.expression)) {
      return undefined
    }

    const known = this.records.get(at)?.get(scope)

    if (known) return known

    const fn = this.fns.get(at.expression.text)

    if (!fn || !ts.isBlock(fn.body)) return undefined

    const last = fn.body.statements[fn.body.statements.length - 1]

    if (
      !last ||
      !ts.isReturnStatement(last) ||
      !last.expression ||
      !ts.isObjectLiteralExpression(last.expression)
    ) {
      return undefined
    }

    const inner = this.bindParams(fn, at.arguments, scope)

    for (const st of fn.body.statements) {
      if (st === last) continue

      if (ts.isVariableStatement(st)) this.declare(st, inner)
      else if (!this.budgetStatement(st, inner)) {
        throw new Port('a helper with statements', [fn.node, at])
      }
    }

    const answer = { record: last.expression, env: inner }
    const seen = this.records.get(at) ?? new WeakMap()

    seen.set(scope, answer)
    this.records.set(at, seen)

    return answer
  }

  recordField(
    record: ts.ObjectLiteralExpression,
    field: string,
  ): ts.Expression | undefined {
    for (const prop of record.properties) {
      if (prop.name?.getText(this.sf) !== field) continue

      if (ts.isPropertyAssignment(prop)) return prop.initializer

      if (ts.isShorthandPropertyAssignment(prop)) return prop.name
    }

    return undefined
  }

  // `Date.now() - started`: the `ms` of the one compile written between the two
  elapsed(node: ts.BinaryExpression, env: Env, ctx: Ctx): string | undefined {
    if (
      node.operatorToken.kind !== ts.SyntaxKind.MinusToken ||
      this.text(node.left) !== 'Date.now()' ||
      !ts.isIdentifier(node.right)
    ) {
      return undefined
    }

    const started = env.get(node.right.text)

    if (
      !started?.node ||
      this.text(started.node) !== 'Date.now()' ||
      !started.env
    ) {
      return undefined
    }

    const compiles: string[] = []

    // a local's scope may be a child that keeps the budget, so its neighbours are looked for up the chain
    for (let at: Env | undefined = started.env; at; at = at.parent) {
      for (const [name, bound] of at.vars) {
        if (
          bound.node &&
          ts.isCallExpression(bound.node) &&
          this.text(bound.node.expression) === 'compile' &&
          bound.node.pos > started.node.pos &&
          bound.node.pos < node.pos
        ) {
          compiles.push(name)
        }
      }
    }

    if (compiles.length !== 1) {
      throw new Port('a time around anything but one compile', [node])
    }

    const name = ts.factory.createIdentifier(compiles[0]!)

    return `${this.name(name, started.env, ctx)}/ms`
  }

  // the compile behind a list of `${d.name}: ${d.message}`, seen through locals and a helper's record
  namedMessages(
    node: ts.Expression,
    env: Env,
  ): { outcome: ts.Expression; env: Env } | undefined {
    if (ts.isPropertyAccessExpression(node)) {
      const held = this.recordOf(node.expression, env)
      const value = held && this.recordField(held.record, node.name.text)

      return value && held ? this.namedMessages(value, held.env) : undefined
    }

    const [at, scope] = this.seenThrough(node, env)

    if (at !== node) return this.namedMessages(at, scope)

    if (ts.isConditionalExpression(at)) {
      return ts.isArrayLiteralExpression(at.whenTrue) &&
        !at.whenTrue.elements.length &&
        /\.ok$/.test(this.text(at.condition))
        ? this.namedMessages(at.whenFalse, scope)
        : undefined
    }

    if (
      !ts.isCallExpression(at) ||
      !ts.isPropertyAccessExpression(at.expression) ||
      at.expression.name.text !== 'map' ||
      !ts.isPropertyAccessExpression(at.expression.expression) ||
      at.expression.expression.name.text !== 'diagnostics'
    ) {
      return undefined
    }

    const arrow = at.arguments[0]

    if (!arrow || !ts.isArrowFunction(arrow) || ts.isBlock(arrow.body)) {
      return undefined
    }

    const param = arrow.parameters[0]?.name.getText(this.sf)

    return this.text(arrow.body) === `\`\${${param}.name}: \${${param}.message}\``
      ? { outcome: at.expression.expression.expression, env: scope }
      : undefined
  }

  // the call a name or an expression comes to, seen through locals, parameters and helpers
  isList(term: string): boolean {
    return /\/(names|messages|warnings|warning-messages|open-claims)$/.test(term)
  }

  expr(node: ts.Expression, env: Env, ctx: Ctx): string {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return this.expr(node.expression, env, ctx)
    }

    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateExpression(node)
    ) {
      return this.fixture(node, env)
    }

    if (ts.isNumericLiteral(node)) return node.text

    if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true'

    if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false'

    if (ts.isIdentifier(node)) return this.name(node, env, ctx)

    if (
      ts.isPrefixUnaryExpression(node) &&
      node.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const value = this.fold(node.operand, env)

      if (typeof value === 'boolean') return String(!value)

      return `not(${this.expr(node.operand, env, ctx)})`
    }

    if (ts.isBinaryExpression(node)) {
      return this.binary(node, env, ctx)
    }

    if (ts.isConditionalExpression(node)) {
      const test = this.fold(node.condition, env)

      if (test === true) return this.expr(node.whenTrue, env, ctx)

      if (test === false) return this.expr(node.whenFalse, env, ctx)

      // `x.ok ? '' : x.diagnostics...`: the diagnostics of a compiled program are empty, so the else is the whole of it
      const empty =
        this.fold(node.whenTrue, env) === '' ||
        (ts.isArrayLiteralExpression(node.whenTrue) &&
          node.whenTrue.elements.length === 0)

      if (
        empty &&
        ts.isPropertyAccessExpression(node.condition) &&
        node.condition.name.text === 'ok'
      ) {
        return this.expr(node.whenFalse, env, ctx)
      }

      // `x.ok ? emitRust(x.program) : ''`: emit-text answers empty on a refused program
      if (
        this.fold(node.whenFalse, env) === '' &&
        ts.isPropertyAccessExpression(node.condition) &&
        node.condition.name.text === 'ok' &&
        ts.isCallExpression(node.whenTrue) &&
        this.emitTarget(node.whenTrue, env)
      ) {
        return this.expr(node.whenTrue, env, ctx)
      }

      throw new Port('a conditional value', [node])
    }

    if (ts.isPropertyAccessExpression(node)) {
      return this.member(node, env, ctx)
    }

    if (ts.isCallExpression(node)) return this.call(node, env, ctx)

    const value = this.fold(node, env)

    if (typeof value === 'string') return `<${escapeText(value)}>`

    throw new Port('a form this tool does not read', [node])
  }

  name(node: ts.Identifier, env: Env, ctx: Ctx): string {
    const bound = env.get(node.text)

    if (!bound) {
      throw new Port(`the name ${node.text}`, [node])
    }

    if (bound.host) return bound.host

    if (bound.hasValue) {
      const value = bound.value

      if (typeof value === 'string') return `<${escapeText(value)}>`

      if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value)
      }

      throw new Port(`the value of ${node.text}`, [node])
    }

    if (!bound.node) {
      throw new Port(`the value of ${node.text}`, bound.stmt ? [bound.stmt] : [node])
    }

    if (bound.param) return this.expr(bound.node, bound.env!, ctx)

    // a local: a host of the test, once
    const local = kebab(node.text)
    const seen = ctx.named.get(local)

    if (seen && seen !== bound) {
      throw new Port(`two values named ${node.text} in one test`, [bound.node])
    }

    if (!seen) {
      const value = this.expr(bound.node, bound.env!, ctx)

      ctx.hosts.push(`host ${local}, ${value}`)
      ctx.named.set(local, bound)
    }

    return local
  }

  binary(node: ts.BinaryExpression, env: Env, ctx: Ctx): string {
    const op = node.operatorToken.kind
    const time = this.elapsed(node, env, ctx)

    if (time) return time

    const named: Partial<Record<ts.SyntaxKind, string>> = {
      [ts.SyntaxKind.AmpersandAmpersandToken]: 'and',
      [ts.SyntaxKind.BarBarToken]: 'or',
      [ts.SyntaxKind.GreaterThanToken]: 'is-above',
      [ts.SyntaxKind.LessThanToken]: 'is-below',
      [ts.SyntaxKind.GreaterThanEqualsToken]: 'is-minimum',
      [ts.SyntaxKind.LessThanEqualsToken]: 'is-maximum',
    }

    if (
      op === ts.SyntaxKind.EqualsEqualsEqualsToken ||
      op === ts.SyntaxKind.ExclamationEqualsEqualsToken
    ) {
      const same = op === ts.SyntaxKind.EqualsEqualsEqualsToken
      const known = this.fold(node, env)

      if (typeof known === 'boolean') return String(known)

      const right = this.fold(node.right, env)

      if (typeof right === 'boolean') {
        const term = this.expr(node.left, env, ctx)

        return right === same ? term : `not(${term})`
      }

      const left = this.stringified(node.left) ?? node.left
      const other = this.stringified(node.right) ?? node.right

      return `${same ? 'is-equal' : 'is-unequal'}(${this.expr(left, env, ctx)}, ${this.expr(other, env, ctx)})`
    }

    const word = named[op]

    if (word) {
      return `${word}(${this.expr(node.left, env, ctx)}, ${this.expr(node.right, env, ctx)})`
    }

    throw new Port(`the operator ${node.operatorToken.getText(this.sf)}`, [
      node,
    ])
  }

  stringified(node: ts.Expression): ts.Expression | undefined {
    if (
      ts.isCallExpression(node) &&
      this.text(node.expression) === 'JSON.stringify' &&
      node.arguments.length === 1
    ) {
      return node.arguments[0]
    }

    return undefined
  }

  member(
    node: ts.PropertyAccessExpression,
    env: Env,
    ctx: Ctx,
  ): string {
    const field = node.name.text
    const held = this.recordOf(node.expression, env)
    const value = held && this.recordField(held.record, field)

    if (held && value) return this.expr(value, held.env, ctx)

    if (field === 'length') {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'diagnostics'
      ) {
        return `${this.expr(node.expression.expression, env, ctx)}/names/length`
      }

      return `${this.expr(node.expression, env, ctx)}/length`
    }

    const fields: Record<string, string> = {
      typescript: 'emitted',
      ok: 'ok',
      openClaims: 'open-claims',
      obligations: 'obligations',
      total: 'total',
      proven: 'proven',
    }

    if (fields[field]) {
      return `${this.expr(node.expression, env, ctx)}/${fields[field]}`
    }

    throw new Port(`the field ${field}`, [node])
  }

  // `.map(d => d.name)` over diagnostics, the part compile-outcome keeps
  diagnosticField(
    node: ts.CallExpression,
    env: Env,
    ctx: Ctx,
  ): string | undefined {
    const callee = node.expression

    if (
      !ts.isPropertyAccessExpression(callee) ||
      callee.name.text !== 'map' ||
      !ts.isPropertyAccessExpression(callee.expression) ||
      !['diagnostics', 'warnings'].includes(callee.expression.name.text)
    ) {
      return undefined
    }

    const arrow = node.arguments[0]

    if (!arrow || !ts.isArrowFunction(arrow) || ts.isBlock(arrow.body)) {
      return undefined
    }

    const param = arrow.parameters[0]?.name.getText(this.sf)
    const body = this.text(arrow.body)
    const base = this.expr(callee.expression.expression, env, ctx)

    if (callee.expression.name.text === 'warnings') {
      if (body === `${param}.message`) return `${base}/warning-messages`

      return body === `${param}.name` ? `${base}/warnings` : undefined
    }

    if (body === `${param}.message`) return `${base}/messages`

    if (body === `${param}.name`) return `${base}/names`

    return undefined
  }

  call(node: ts.CallExpression, env: Env, ctx: Ctx): string {
    const callee = node.expression

    if (ts.isIdentifier(callee)) {
      if (callee.text === 'compile' && !env.get('compile')) {
        return this.compileCall(node, env)
      }

      if (this.fixtureTasks.has(callee.text)) {
        return this.fixture(node, env)
      }

      const target = this.emitTarget(node, env)

      if (target) {
        const given = node.arguments[0]

        if (
          given &&
          ts.isPropertyAccessExpression(given) &&
          given.name.text === 'program' &&
          node.arguments.length === 1
        ) {
          this.uses.add('emit-text')

          return `emit-text(${this.expr(given.expression, env, ctx)}, <${target}>)`
        }

        throw new Port(`the call ${callee.text}() of anything but a compile's program`, [node])
      }

      const fn = this.fns.get(callee.text)

      if (!fn) {
        throw new Port(`the call ${callee.text}()`, [node])
      }

      return this.inline(fn, node, env, ctx)
    }

    if (ts.isPropertyAccessExpression(callee)) {
      const known = this.diagnosticField(node, env, ctx)

      if (known) return known

      return this.method(node, callee, env, ctx)
    }

    throw new Port('a call this tool does not read', [node])
  }

  // which emitter a call is, seen through a loop's name for it
  emitTarget(node: ts.CallExpression, env: Env): string | undefined {
    const [callee] = this.seenThrough(node.expression, env)
    const targets: Record<string, string> = {
      emitRust: 'rust',
      emitSwift: 'swift',
      emitKotlin: 'kotlin',
      emitTypeScript: 'typescript',
    }
    const name = this.text(callee)

    return !this.fns.has(name) ? targets[name] : undefined
  }

  // a helper's value: its body is an expression, or lets then one return
  inline(fn: Fn, node: ts.CallExpression, env: Env, ctx: Ctx): string {
    const inner = this.bindParams(fn, node.arguments, env)

    if (!ts.isBlock(fn.body)) return this.expr(fn.body, inner, ctx)

    let back: ts.Expression | undefined

    for (const st of fn.body.statements) {
      if (ts.isVariableStatement(st)) {
        this.declare(st, inner)
      } else if (ts.isReturnStatement(st) && st.expression) {
        back = st.expression
      } else if (!this.budgetStatement(st, inner)) {
        throw new Port('a helper with statements', [fn.node, node])
      }
    }

    if (!back) throw new Port('a helper with no value', [fn.node, node])

    if (ts.isObjectLiteralExpression(back)) {
      throw new Port('a helper answering a record', [fn.node, node])
    }

    return this.expr(back, inner, ctx)
  }

  method(
    node: ts.CallExpression,
    callee: ts.PropertyAccessExpression,
    env: Env,
    ctx: Ctx,
  ): string {
    const method = callee.name.text
    const args = node.arguments

    // `.some(m => m.includes(w))` over `${d.name}: ${d.message}`. A name has no space, so a word with a space that
    // does not hold the ': ' or a line break can only be inside one message, and the joined messages read the same
    if (method === 'some' && args[0] && ts.isArrowFunction(args[0])) {
      const arrow = args[0]
      const param = arrow.parameters[0]?.name.getText(this.sf)
      const seen = this.namedMessages(callee.expression, env)

      if (
        seen &&
        ts.isCallExpression(arrow.body) &&
        this.text(arrow.body.expression) === `${param}.includes` &&
        arrow.body.arguments.length === 1
      ) {
        const word = this.fold(arrow.body.arguments[0]!, env)

        if (
          typeof word === 'string' &&
          word.includes(' ') &&
          !word.includes(': ') &&
          !word.includes('\n')
        ) {
          this.uses.add('text-contains')
          this.uses.add('join')

          return `text-contains(join(${this.expr(seen.outcome, seen.env, ctx)}/messages, <\\n>), <${escapeText(word)}>)`
        }
      }
    }

    // a regular expression's test: a plain text needs no pattern
    const [testing] = this.seenThrough(callee.expression, env)

    if (
      method === 'test' &&
      testing.kind === ts.SyntaxKind.RegularExpressionLiteral
    ) {
      const raw = testing.getText(this.sf)
      const end = raw.lastIndexOf('/')
      const source = raw.slice(1, end)
      const flags = raw.slice(end + 1)

      if (flags) throw new Port(`a regular expression's flags`, [node])

      const subject = this.expr(args[0]!, env, ctx)

      if (!/[\\^$.|?*+()[\]{}]/.test(source)) {
        this.uses.add('text-contains')

        return `text-contains(${subject}, <${escapeText(source)}>)`
      }

      this.uses.add('matches')

      const label = `pattern-${ctx.hosts.length + 1}`

      ctx.hosts.push(`host ${label}, make pattern, <<${source}>>`)

      return `matches(${label}, ${subject})`
    }

    // diagnostics.some(d => d.name === x) and the same of warnings, the name among the reasons
    if (
      method === 'some' &&
      ts.isPropertyAccessExpression(callee.expression) &&
      ['diagnostics', 'warnings'].includes(callee.expression.name.text)
    ) {
      const arrow = args[0]
      const field =
        callee.expression.name.text === 'warnings' ? 'warnings' : 'names'

      if (
        arrow &&
        ts.isArrowFunction(arrow) &&
        !ts.isBlock(arrow.body) &&
        ts.isBinaryExpression(arrow.body) &&
        this.text(arrow.body.left) ===
          `${arrow.parameters[0]!.name.getText(this.sf)}.name`
      ) {
        this.uses.add('list-contains')

        return `contains(${this.expr(callee.expression.expression, env, ctx)}/${field}, ${this.expr(arrow.body.right, env, ctx)})`
      }
    }

    const recv = this.expr(callee.expression, env, ctx)
    const arg = (at: number): string => this.expr(args[at]!, env, ctx)

    switch (method) {
      case 'includes': {
        if (this.isList(recv)) {
          this.uses.add('list-contains')

          return `contains(${recv}, ${arg(0)})`
        }

        this.uses.add('text-contains')

        return `text-contains(${recv}, ${arg(0)})`
      }
      case 'join':
        this.uses.add('join')

        return `join(${recv}, ${arg(0)})`
      case 'split':
        this.uses.add('split')

        return `split(${recv}, ${arg(0)})`
      case 'trim':
        this.uses.add('trim')

        return `trim(${recv})`
      case 'startsWith':
        this.uses.add('starts-with')

        return `starts-with(${recv}, ${arg(0)})`
      case 'slice':
        if (args.length === 2) {
          this.uses.add('substring')

          return `substring(${recv}, ${arg(0)}, ${arg(1)})`
        }
        break
    }

    throw new Port(`the method .${method}()`, [node])
  }

  // ---- statements ----

  declare(st: ts.VariableStatement, env: Env): void {
    for (const decl of st.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) {
        // a local is read later, when the suite may have moved the budget: it keeps the one in force here
        const budget = env.get(BUDGET)
        const scope = budget ? new Env(env) : env

        if (budget) scope.vars.set(BUDGET, budget)

        env.vars.set(decl.name.text, {
          node: decl.initializer,
          env: scope,
          stmt: st,
        })
      } else {
        for (const name of this.boundNames(decl.name)) {
          env.vars.set(name, { stmt: st })
        }
      }
    }
  }

  boundNames(pattern: ts.BindingName): string[] {
    if (ts.isIdentifier(pattern)) return [pattern.text]

    const out: string[] = []

    for (const el of pattern.elements) {
      if (ts.isBindingElement(el)) out.push(...this.boundNames(el.name))
    }

    return out
  }

  bindPattern(pattern: ts.BindingName, value: unknown, env: Env): void {
    if (ts.isIdentifier(pattern)) {
      env.vars.set(pattern.text, { value, hasValue: true })

      return
    }

    if (ts.isArrayBindingPattern(pattern) && Array.isArray(value)) {
      pattern.elements.forEach((el, at) => {
        if (ts.isBindingElement(el)) {
          this.bindPattern(el.name, value[at], env)
        }
      })

      return
    }

    throw new Port('a pattern this tool does not read', [pattern])
  }

  isChrome(st: ts.Statement): boolean {
    const text = this.text(st)

    return (
      /^console\.(log|error)\(/.test(text) ||
      /^process\.exit\(/.test(text) ||
      /^process\.exitCode\s*=/.test(text) ||
      /^if \(\s*fail\b/.test(text) ||
      /^(let|const) (pass|fail)\b/.test(text)
    )
  }

  reachesCounter(node: ts.Node): boolean {
    let found = false
    const visit = (at: ts.Node): void => {
      if (ts.isCallExpression(at) && ts.isIdentifier(at.expression)) {
        const fn = this.fns.get(at.expression.text)

        if (fn && (this.isCounter(fn) || this.isWrapper(fn))) found = true
      }

      ts.forEachChild(at, visit)
    }

    visit(node)

    return found
  }

  walk(
    statements: readonly ts.Statement[],
    env: Env,
    guards: { node: ts.Expression; env: Env }[],
    top = false,
  ): void {
    for (const st of statements) {
      if (top) this.comments(st)

      if (this.isChrome(st)) continue

      if (ts.isImportDeclaration(st)) continue

      if (ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st)) {
        continue
      }

      if (ts.isFunctionDeclaration(st)) continue

      if (ts.isVariableStatement(st)) {
        if (top) {
          this.topConst(st, env)
        } else if (!this.fnOf(st)) {
          this.declare(st, env)
        }

        continue
      }

      if (ts.isBlock(st)) {
        this.walk(st.statements, new Env(env), guards)
        continue
      }

      if (ts.isForOfStatement(st)) {
        this.forOf(st, env, guards)
        continue
      }

      if (this.budgetStatement(st, env)) continue

      if (ts.isIfStatement(st)) {
        if (this.inlineCount(st, env, guards)) continue

        if (this.reachesCounter(st.thenStatement)) {
          if (st.elseStatement) {
            this.filePort(st, 'an else over a test')
            continue
          }

          const body = ts.isBlock(st.thenStatement)
            ? st.thenStatement.statements
            : [st.thenStatement]

          this.walk(body, new Env(env), [
            ...guards,
            { node: st.expression, env },
          ])
          continue
        }

        if (/process\.env/.test(this.text(st))) {
          env.taint = `the compile reads a process.env this harness cannot set: ${this.text(st.expression)}`
          continue
        }

        this.filePort(st, 'a statement outside the idiom')
        continue
      }

      if (ts.isExpressionStatement(st)) {
        const e = st.expression

        if (/process\.env/.test(this.text(e))) {
          if (!/^delete /.test(this.text(e))) {
            env.taint = `the compile reads a process.env this harness cannot set: ${this.text(e)}`
          }

          continue
        }

        if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
          const fn = this.fns.get(e.expression.text)

          if (fn && this.isCounter(fn)) {
            this.counted(fn, e, env, guards)
            continue
          }

          if (fn && this.isWrapper(fn) && ts.isBlock(fn.body)) {
            const inner = this.bindParams(fn, e.arguments, env)

            this.hoist(fn.body.statements, inner)
            this.walk(fn.body.statements, inner, guards)
            continue
          }
        }
      }

      this.filePort(st, 'a statement outside the idiom')
    }
  }

  hoist(statements: readonly ts.Statement[], env: Env): void {
    for (const st of statements) {
      const fn = this.fnOf(st)

      if (fn && ts.isVariableStatement(st)) {
        this.fns.set(
          st.declarationList.declarations[0]!.name.getText(this.sf),
          fn,
        )
      }
    }

    void env
  }

  forOf(
    st: ts.ForOfStatement,
    env: Env,
    guards: { node: ts.Expression; env: Env }[],
  ): void {
    const items = this.fold(st.expression, env)
    const decl = ts.isVariableDeclarationList(st.initializer)
      ? st.initializer.declarations[0]
      : undefined
    const [written] = this.seenThrough(st.expression, env)

    // rows that hold what no fold can, a regular expression or an emitter: each name stands for the node in its row
    if (
      !Array.isArray(items) &&
      decl &&
      ts.isArrayBindingPattern(decl.name) &&
      ts.isArrayLiteralExpression(written) &&
      written.elements.every(row => ts.isArrayLiteralExpression(row))
    ) {
      for (const row of written.elements) {
        const inner = new Env(env)

        decl.name.elements.forEach((el, at) => {
          if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
            inner.vars.set(el.name.text, {
              node: (row as ts.ArrayLiteralExpression).elements[at]!,
              env,
            })
          }
        })

        const body = ts.isBlock(st.statement)
          ? st.statement.statements
          : [st.statement]

        this.walk(body, inner, guards)
      }

      return
    }

    if (!Array.isArray(items) || !decl) {
      this.filePort(st, 'a loop over a value this tool cannot read')

      return
    }

    for (const item of items) {
      const inner = new Env(env)

      this.bindPattern(decl.name, item, inner)

      const body = ts.isBlock(st.statement)
        ? st.statement.statements
        : [st.statement]

      this.walk(body, inner, guards)
    }
  }

  // `if (good) { pass++, console.log('ok  <name>') } else { fail++ ... }`, written where it counts: one test, named by its
  // line. Nothing else may sit in the arm, or the test would lose it
  inlineCount(
    st: ts.IfStatement,
    env: Env,
    guards: { node: ts.Expression; env: Env }[],
  ): boolean {
    const arm = (body: ts.Statement | undefined): readonly ts.Statement[] =>
      !body ? [] : ts.isBlock(body) ? body.statements : [body]
    const yes = arm(st.thenStatement)
    const no = arm(st.elseStatement)
    const counts = (list: readonly ts.Statement[], word: string): boolean =>
      list.some(line => this.text(line).replace(/;$/, '') === `${word}++`)
    const prints = (line: ts.Statement): boolean =>
      /^console\.(log|error)\(/.test(this.text(line))

    if (
      !counts(yes, 'pass') ||
      !counts(no, 'fail') ||
      !yes.every(line => prints(line) || counts([line], 'pass')) ||
      !no.every(line => prints(line) || counts([line], 'fail'))
    ) {
      return false
    }

    const line = yes.find(prints)
    const said =
      line &&
      ts.isExpressionStatement(line) &&
      ts.isCallExpression(line.expression) &&
      line.expression.arguments[0]
        ? this.fold(line.expression.arguments[0], env)
        : NOPE

    if (typeof said !== 'string') return false

    const title = said.replace(/^ok\s+/, '')
    const ctx: Ctx = { hosts: [], named: new Map() }
    const wants: string[] = []
    const ported: string[] = []

    this.tests++

    try {
      for (const part of [...guards, { node: st.expression, env }]) {
        for (const term of this.wantsOf(part.node, part.env, ctx)) {
          wants.push(`want hold, ${term}`)
        }
      }
    } catch (error) {
      if (!(error instanceof Port)) throw error

      this.note(error.reason)
      this.portWants++
      this.portTests++
      ported.push(`# PORT: ${error.reason}`)

      const lines = new Set<number>(this.span(st))

      for (const node of error.at) {
        for (const at of this.span(node)) lines.add(at)
      }

      this.references(st, env, lines)

      for (const at of [...lines].sort((a, b) => a - b)) {
        this.portedLines.add(at)
        ported.push(`# PORT: ${this.lines[at]!.trimEnd()}`)
      }

      ported.push('want hold, false')
    }

    this.wants += wants.length
    this.body.push(`test <${escapeText(title)}>`)

    for (const text of [...ctx.hosts, ...ported, ...wants]) {
      this.body.push(`  ${text}`)
    }

    this.body.push('')

    return true
  }

  // a call of a function that counts: one test
  counted(
    fn: Fn,
    call: ts.CallExpression,
    env: Env,
    guards: { node: ts.Expression; env: Env }[],
  ): void {
    const inner = this.bindParams(fn, call.arguments, env)
    const ctx: Ctx = { hosts: [], named: new Map() }
    const wants: string[] = []
    const ported: string[] = []
    const name = call.arguments[0]
      ? this.fold(call.arguments[0], env)
      : NOPE
    const title =
      typeof name === 'string'
        ? name
        : call.arguments[0]
          ? this.text(call.arguments[0])
          : 'unnamed'

    this.tests++

    if (ts.isBlock(fn.body)) {
      for (const st of fn.body.statements) {
        if (ts.isVariableStatement(st)) this.declare(st, inner)
        else if (this.budgetStatement(st, inner)) continue
        else if (
          ts.isExpressionStatement(st) &&
          /process\.env/.test(this.text(st))
        ) {
          if (!/^delete /.test(this.text(st))) {
            inner.taint = `the compile reads a process.env this harness cannot set`
          }
        } else if (
          ts.isIfStatement(st) &&
          /process\.env/.test(this.text(st))
        ) {
          inner.taint = `the compile reads a process.env this harness cannot set`
        }
      }
    }

    const condition = this.conditionOf(fn)
    const parts: { node: ts.Expression; env: Env }[] = [...guards]

    if (condition) {
      parts.push({ node: condition, env: inner })
    }

    const portOf = (error: unknown, at: ts.Node[]): void => {
      if (!(error instanceof Port)) throw error

      this.note(error.reason)
      this.portWants++
      ported.push(`# PORT: ${error.reason}`)

      const lines = new Set<number>()

      for (const node of [...at, ...error.at]) {
        for (const line of this.span(node)) lines.add(line)
      }

      for (const node of [call, ...error.at]) {
        this.references(node, inner, lines)
        this.references(node, env, lines)
      }

      for (const line of [...lines].sort((a, b) => a - b)) {
        this.portedLines.add(line)
        ported.push(`# PORT: ${(this.lines[line] ?? '').trimEnd()}`)
      }

      ported.push('want hold, false')
    }

    if (!condition) {
      portOf(new Port('a counter with no condition', []), [call, fn.node])
    }

    for (const part of parts) {
      try {
        for (const term of this.wantsOf(part.node, part.env, ctx)) {
          wants.push(`want hold, ${term}`)
        }
      } catch (error) {
        portOf(error, [call])
      }
    }

    if (ported.length) this.portTests++

    this.wants += wants.length
    this.body.push(`test <${escapeText(title)}>`)

    for (const line of [...ctx.hosts, ...ported, ...wants]) {
      this.body.push(`  ${line}`)
    }

    this.body.push('')
  }

  // the `if (c) pass++` of a counter
  conditionOf(fn: Fn): ts.Expression | undefined {
    if (!ts.isBlock(fn.body)) return undefined

    for (const st of fn.body.statements) {
      if (ts.isIfStatement(st) && /\bpass\b/.test(this.text(st.thenStatement))) {
        return st.expression
      }

      if (ts.isIfStatement(st) && /\bfail\b/.test(this.text(st.thenStatement))) {
        return ts.factory.createPrefixUnaryExpression(
          ts.SyntaxKind.ExclamationToken,
          st.expression,
        )
      }
    }

    return undefined
  }

  // a want per conjunct: `!r.ok && r.diagnostics.some(d => d.name === x)` is refused-as
  wantsOf(node: ts.Expression, env: Env, ctx: Ctx): string[] {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isNonNullExpression(node)
    ) {
      return this.wantsOf(node.expression, env, ctx)
    }

    if (ts.isIdentifier(node)) {
      const bound = env.get(node.text)

      if (bound?.param && bound.node) {
        return this.wantsOf(bound.node, bound.env!, ctx)
      }
    }

    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
    ) {
      const refused = this.refusedAs(node, env, ctx)

      if (refused) return [refused]

      return [
        ...this.wantsOf(node.left, env, ctx),
        ...this.wantsOf(node.right, env, ctx),
      ]
    }

    if (ts.isConditionalExpression(node)) {
      const test = this.fold(node.condition, env)

      if (test === true) return this.wantsOf(node.whenTrue, env, ctx)

      if (test === false) return this.wantsOf(node.whenFalse, env, ctx)
    }

    return [this.expr(node, env, ctx)]
  }

  refusedAs(
    node: ts.BinaryExpression,
    env: Env,
    ctx: Ctx,
  ): string | undefined {
    const left = node.left
    const right = node.right

    if (
      !ts.isPrefixUnaryExpression(left) ||
      left.operator !== ts.SyntaxKind.ExclamationToken ||
      !ts.isPropertyAccessExpression(left.operand) ||
      left.operand.name.text !== 'ok' ||
      !ts.isCallExpression(right) ||
      !ts.isPropertyAccessExpression(right.expression) ||
      right.expression.name.text !== 'some' ||
      !ts.isPropertyAccessExpression(right.expression.expression) ||
      right.expression.expression.name.text !== 'diagnostics'
    ) {
      return undefined
    }

    const arrow = right.arguments[0]

    if (
      !arrow ||
      !ts.isArrowFunction(arrow) ||
      ts.isBlock(arrow.body) ||
      !ts.isBinaryExpression(arrow.body) ||
      this.text(arrow.body.left) !==
        `${arrow.parameters[0]!.name.getText(this.sf)}.name`
    ) {
      return undefined
    }

    this.uses.add('refused-as')

    return `refused-as(${this.expr(left.operand.expression, env, ctx)}, ${this.expr(arrow.body.right, env, ctx)})`
  }

  // what a ported node leans on: its local lets, and each helper of the file, once at the top
  references(node: ts.Node, env: Env, lines: Set<number>): void {
    const seen = new Set<string>()
    const visit = (at: ts.Node): void => {
      if (ts.isIdentifier(at) && !seen.has(at.text)) {
        seen.add(at.text)

        const bound = env.get(at.text)

        if (bound?.stmt && !this.isTopStatement(bound.stmt)) {
          for (const line of this.span(bound.stmt)) lines.add(line)

          visit(bound.stmt)
        }

        this.portDecl(at.text)
      }

      ts.forEachChild(at, visit)
    }

    visit(node)
  }

  isTopStatement(node: ts.Node): boolean {
    return node.parent === this.sf
  }

  portDecl(name: string): void {
    if (this.portedDeclNames.has(name)) return

    const decl = this.decls.get(name)

    if (!decl) return

    const fn = this.fnOf(decl)

    if (this.textHosts.has(name) || this.fixtureTasks.has(name)) return

    if (fn && this.isCounter(fn)) return

    this.portedDeclNames.add(name)

    for (const line of this.span(decl)) {
      this.portedLines.add(line)
      this.portedDecls.push(`# PORT: ${(this.lines[line] ?? '').trimEnd()}`)
    }

    const visit = (at: ts.Node): void => {
      if (ts.isIdentifier(at)) this.portDecl(at.text)

      ts.forEachChild(at, visit)
    }

    visit(decl)
  }

  filePort(st: ts.Node, reason: string): void {
    this.note(reason)
    this.body.push(`# PORT: ${reason}`)

    for (const line of this.span(st)) {
      this.portedLines.add(line)
      this.body.push(`# PORT: ${(this.lines[line] ?? '').trimEnd()}`)
    }

    this.body.push('')
  }

  note(reason: string): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
  }

  topConst(st: ts.VariableStatement, env: Env): void {
    for (const decl of st.declarationList.declarations) {
      const name = decl.name.getText(this.sf)
      const init = decl.initializer

      if (!init) continue

      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        if (this.fixtureTasks.has(name)) {
          try {
            this.fixtureTask(name, init)
          } catch (error) {
            if (!(error instanceof Port)) throw error

            // a text this tool cannot hold: an ordinary helper, its callers PORT
            this.fixtureTasks.delete(name)
          }
        }

        continue
      }

      if (
        ts.isIdentifier(decl.name) &&
        (ts.isStringLiteral(init) ||
          ts.isNoSubstitutionTemplateLiteral(init) ||
          ts.isTemplateExpression(init))
      ) {
        try {
          const text = this.fixture(init, env)
          const host = kebab(name)

          env.vars.set(name, { node: init, env, host, stmt: st })
          this.textHosts.add(name)
          this.body.push(`host ${host}, ${text}`, '')
          continue
        } catch (error) {
          if (!(error instanceof Port)) throw error
        }
      }

      this.declare(st, env)
    }
  }

  fixtureTask(
    name: string,
    init: ts.ArrowFunction | ts.FunctionExpression,
  ): void {
    const inner = new Env(this.top)
    const take: string[] = []

    for (const param of init.parameters) {
      const raw = param.name.getText(this.sf)
      const term = kebab(raw)

      inner.vars.set(raw, { host: term, param: true })
      take.push(`  take ${term}, like text`)
    }

    const body = this.fixture(init.body as ts.Expression, inner)

    this.body.push(
      `task ${this.fixtureTasks.get(name)}`,
      ...take,
      '  like text',
      '',
      `  back ${body}`,
      '',
    )
  }

  // a fixture task: one expression, a text of plain text parameters whose holes are names
  isFixtureTask(init: ts.Node): boolean {
    if (
      !ts.isArrowFunction(init) ||
      ts.isBlock(init.body) ||
      !(
        ts.isTemplateExpression(init.body) ||
        ts.isNoSubstitutionTemplateLiteral(init.body)
      )
    ) {
      return false
    }

    for (const param of init.parameters) {
      if (
        !param.type ||
        param.type.kind !== ts.SyntaxKind.StringKeyword
      ) {
        return false
      }
    }

    if (ts.isTemplateExpression(init.body)) {
      return init.body.templateSpans.every(span =>
        ts.isIdentifier(span.expression),
      )
    }

    return true
  }

  printed = new Set<number>()

  comments(st: ts.Statement): void {
    const ranges =
      ts.getLeadingCommentRanges(this.source, st.getFullStart()) ?? []
    const lines = ranges.flatMap(range =>
      this.source
        .slice(range.pos, range.end)
        .split('\n')
        .map(line => line.replace(/^\s*(\/\/|\/\*+|\*+\/?)\s?/, '').trimEnd()),
    )

    if (ranges.length && !this.printed.has(ranges[0]!.pos)) {
      this.printed.add(ranges[0]!.pos)

      for (const line of lines) this.body.push(`# ${line}`.trimEnd())
    }
  }

  // ---- the file ----

  run(): void {
    for (const st of this.sf.statements) {
      const fn = this.fnOf(st)

      if (ts.isFunctionDeclaration(st) && st.name) {
        this.decls.set(st.name.text, st)
        if (fn) this.fns.set(st.name.text, fn)
      } else if (ts.isVariableStatement(st)) {
        for (const decl of st.declarationList.declarations) {
          const name = decl.name.getText(this.sf)

          this.decls.set(name, st)

          if (fn) this.fns.set(name, fn)

          if (decl.initializer && this.isFixtureTask(decl.initializer)) {
            this.fixtureTasks.set(name, `${kebab(name).replace(/-text$/, '')}-text`)
          }
        }
      }
    }

    this.walk(this.sf.statements, this.top, [], true)
  }

  output(treeFile: string): string {
    const supportDir = this.supportDir(treeFile)
    const head = this.headerNote()
    const compiling = [
      'compile-text',
      'compile-choice',
      'compiling-source',
      'refused-as',
      'refused-saying',
      'emit-text',
      'project-path',
      'file-text',
    ].filter(name => this.uses.has(name))
    const out: string[] = [`note <${escapeText(head)}>`, '']

    out.push(`# Ported from ${basename(this.file)} by task/term/suite-port.ts.`, '')

    if (compiling.length) {
      out.push(`load ${supportDir}/compiling`)
      for (const name of compiling) out.push(`  find ${name}`)
      out.push('')
    }

    if (this.uses.has('list-contains')) {
      out.push('load @term/base/list', '  find contains', '')
    }

    const text = ['split', 'trim', 'starts-with', 'substring'].filter(name =>
      this.uses.has(name),
    )

    if (text.length || this.uses.has('text-contains')) {
      out.push('load @term/base/text')
      for (const name of text) out.push(`  find ${name}`)
      if (this.uses.has('text-contains')) {
        out.push('  find contains, name text-contains')
      }
      out.push('')
    }

    if (this.uses.has('join')) {
      out.push('load @term/base/text/util', '  find join', '')
    }

    if (this.uses.has('matches')) {
      out.push('load @term/base/pattern', '  find pattern', '  find matches', '')
    }

    if (this.portedDecls.length) {
      out.push(
        '# PORT: helpers of the suite this tool does not read',
        ...this.portedDecls,
        '',
      )
    }

    return `${[...out, ...this.body].join('\n').replace(/\n+$/, '')}\n`
  }

  supportDir(treeFile: string): string {
    const dir = dirname(resolve(treeFile))
    const parts = dir.split(sep)
    const at = parts.lastIndexOf('test')
    const root = at >= 0 ? parts.slice(0, at + 1).join(sep) : dir
    const rel = relative(dir, join(root, 'support')).split(sep).join('/')

    return rel.startsWith('.') ? rel : `./${rel}`
  }

  headerNote(): string {
    const first = this.sf.statements[0]
    const ranges = first
      ? (ts.getLeadingCommentRanges(this.source, first.getFullStart()) ?? [])
      : []
    const lines = ranges.map(range =>
      this.source
        .slice(range.pos, range.end)
        .replace(/^\/\/\s?/, '')
        .trim(),
    )
    const joined = lines.join(' ')
    const sentence = /^(.*?[.:])(\s|$)/.exec(joined)?.[1] ?? joined

    return sentence.replace(/[.:]$/, '') || basename(this.file)
  }

  stats(): Record<string, unknown> {
    const code = (line: string): boolean => {
      const t = line.trim()

      return t !== '' && !t.startsWith('//')
    }
    const codeLines = this.lines.filter(code).length
    const left = [...this.portedLines].filter(at =>
      code(this.lines[at] ?? ''),
    ).length

    return {
      file: this.file,
      lines: this.lines.length - 1,
      codeLines,
      tests: this.tests,
      testsWithPort: this.portTests,
      wantsPorted: this.portWants,
      wantsConverted: this.wants,
      linesLeft: left,
      shareLeft: Number((left / Math.max(codeLines, 1)).toFixed(3)),
      reasons: Object.fromEntries(this.reasons),
    }
  }
}

function main(): void {
  const args = process.argv.slice(2)
  const files = args.filter((arg, at) => !arg.startsWith('--') && args[at - 1] !== '--out')
  const outAt = args.indexOf('--out')
  const commit = args.includes('--commit')
  const asJson = args.includes('--json')
  const file = files[0]

  if (!file || files.length > 1) {
    console.error('usage: suite-port.ts <file.ts> [--out <file.tree>] [--commit] [--json]')
    process.exit(2)
  }

  const treeFile =
    outAt >= 0 ? args[outAt + 1]! : file.replace(/\.ts$/, '.tree')
  const converter = new Converter(file, readFileSync(file, 'utf8'))

  converter.run()

  const text = converter.output(file)
  const stats = converter.stats()

  if (asJson) console.log(JSON.stringify(stats))
  else console.log(stats)

  if (!commit) {
    console.log(`NOT WRITTEN: this was a report. --commit writes ${treeFile}`)

    return
  }

  if (outAt < 0 && existsSync(treeFile)) {
    console.error(`refused: ${treeFile} exists, and may hold a hand pass`)
    process.exit(1)
  }

  writeFileSync(treeFile, text)
  console.log(`wrote ${treeFile}`)
}

main()
