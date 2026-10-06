// A MASK'S DEFAULT TASKS, given to every form that wears the mask and leaves them out. A task with a body inside a
// `mask` is minted once as a generic task over the wearing form, `<mask>_<task>` (compile/mint-bridge.ts). Here each
// `wear` (or `suit`) that lacks one gets the method `<form>_<task>`, which calls it, and the instance lists it, so a
// call on the form, a dictionary on TypeScript and an `impl` natively all find it the way they find a written one.
//
// Only an instance in a file this build emits is filled: a separate unit holds the stubs of its whole closure, and a
// stub's instance was filled in its own unit, whose stub then carries the method. A task the form writes itself wins.
import type { Expression, Program, Statement, Type } from '@term/make/code/compile/node'

type Fn = Extract<Statement, { form: 'function' }>

// `scoped` says whether only the instances of the files in `own` are filled. The program is handed back
export function fillMaskDefaults(program: Program, scoped: boolean, files: string[]): Program {
  const owned = new Set(files)
  const own = scoped ? (file: string | undefined) => file !== undefined && owned.has(file) : undefined
  const masks = new Map<string, Extract<Statement, { form: 'mask' }>>()
  const forms = new Map<string, Extract<Statement, { form: 'record-type' }>>()
  const functions = new Map<string, Fn>()

  for (const statement of program) {
    if (statement.form === 'mask') masks.set(statement.name, statement)
    else if (statement.form === 'record-type') forms.set(statement.name, statement)
    else if (statement.form === 'function') functions.set(statement.name.replace(/(__in\d+_\d+)?(__\d+)*$/, ''), statement)
  }

  const added: Statement[] = []

  for (const statement of program) {
    if (statement.form !== 'instance' || (own && !own(statement.span.file))) {
      continue
    }

    const mask = masks.get(statement.mask)

    for (const task of mask?.tasks ?? []) {
      if (!task.default || statement.methods.includes(task.name)) {
        continue
      }

      const shared = functions.get(`${statement.mask}_${task.name}`)

      if (!shared) {
        continue
      }

      const span = statement.span
      const params = (forms.get(statement.target)?.params ?? [])
      const self: Type = { kind: 'named', name: statement.target, args: params.map(p => ({ kind: 'named' as const, name: p })) }
      const variable = (name: string): Expression => ({ form: 'variable', name, span })
      // the shared task's own parameters, `self` the form
      const passed = shared.params.map((param, i) => ({ ...param, ...(i === 0 ? { type: self } : {}) }))
      const call: Expression = {
        form: 'call',
        callee: variable(shared.stubExport ?? shared.name),
        args: passed.map(param => variable(param.name)),
        span,
      }

      added.push({
        form: 'function',
        name: `${statement.target}_${task.name}`,
        params: passed.map(({ fallback: _f, ...param }) => param),
        body: [{ form: 'return', value: call, span }],
        ...(task.signature.result ? { result: task.signature.result } : {}),
        generics: params.map(name => ({ name })),
        method: { form: statement.target, name: task.name },
        span,
      })
      statement.methods.push(task.name)
    }
  }

  program.push(...added)

  return program
}
