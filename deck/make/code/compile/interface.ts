// The public INTERFACE (signature) of a module, and a fingerprint of it. This
// is the firewall for incremental type-checking: a module's dependents depend
// on its interface, NOT its implementation, so a body-only edit (which leaves
// the interface unchanged) must not force dependents to re-check. Comparing
// `interfaceHash` before/after an edit is the early-cutoff signal (the same
// role TypeScript's emitted `.d.ts` plays, and rustc/salsa's signature query).
//
// The interface is everything a CONSUMER of the module can observe: public
// function signatures (name + parameter types + result + generics, but NOT the
// body), record-type shapes, traits, instances, and native/bind signatures.
// Private definitions and all function bodies are deliberately excluded - they
// are the implementation behind the firewall.
//
// Pure and deterministic (sorted), so the fingerprint is stable across runs.

import type {
  Program,
  Statement,
  Type,
} from '@term/make/code/compile/node'
import { hashText } from '@term/make/code/compile/cache'

// a stable, structural string for a type (no spans, no inference ids that vary)
function typeKey(type: Type | undefined): string {
  if (!type) {return '?'}

  switch (type.kind) {
    case 'array':
      return `[${typeKey(type.element)}]`
    case 'map':
      return `{${typeKey(type.key)}:${typeKey(type.value)}}`
    case 'named':
      return `${type.name}${type.args?.length ? `<${type.args.map(typeKey).join(',')}>` : ''}`
    case 'function':
      return `(${type.params.map(typeKey).join(',')})->${typeKey(type.result)}`
    case 'variable':
      // an unresolved inference variable: its numeric id is not stable, so
      // collapse to a placeholder. A surfaced interface should be concrete; if
      // a variable leaks in it is conservatively treated as "any variable".
      return 'var'
    default:
      return type.kind
  }
}

// the signature line for one public definition, or undefined if it is private /
// not part of the surface (function bodies never appear here)
function signatureOf(statement: Statement): string | undefined {
  switch (statement.form) {
    case 'function': {
      if (statement.private) {return undefined}

      const params = statement.params
        .map(p => `${p.name}:${typeKey(p.type)}`)
        .join(',')

      const generics = statement.generics
        .map(g => `${g.name}${g.need ? `:${g.need}` : ''}`)
        .join(',')

      return `fn ${statement.name}<${generics}>(${params})->${typeKey(statement.result)}${statement.async ? ' async' : ''}`
    }

    case 'record-type': {
      const fields = statement.fields
        .map(f => `${f.name}:${typeKey(f.type)}`)
        .join(',')

      const variants = statement.variants
        .map(
          v =>
            `${v.name}(${v.fields.map(f => `${f.name}:${typeKey(f.type)}`).join(',')})`,
        )
        .join('|')

      const params = statement.params.join(',')

      return `type ${statement.name}<${params}> {${fields}}${variants ? ` =${variants}` : ''}${statement.alias ? ` alias ${typeKey(statement.alias)}` : ''}`
    }

    case 'mask':
      return `mask ${statement.name} {${[...statement.methods].sort().join(',')}}`
    case 'instance':
      return `instance ${statement.mask} for ${statement.target} {${[...statement.methods].sort().join(',')}}`

    case 'bind': {
      const params = statement.params
        .map(p => `${p.name}:${typeKey(p.type)}`)
        .join(',')

      return `bind ${statement.name}(${params})->${typeKey(statement.result)}`
    }

    case 'native':
      return `native ${statement.alias}=${statement.module}${statement.kind ? `:${statement.kind}` : ''}`
    default:
      return undefined // expressions, lets, etc. are not module surface
  }
}

/** Every public signature in a program, sorted (the module's observable interface). */
export function moduleInterface(program: Program): string[] {
  const sigs: string[] = []

  for (const statement of program) {
    const sig = signatureOf(statement)

    if (sig !== undefined) {sigs.push(sig)}
  }

  return sigs.sort()
}

/**
 * A content fingerprint of a module's public interface. Unchanged across any
 * edit that does not alter the surface (a function body rewrite, a private
 * helper change, a comment) - which is exactly when dependents can be reused.
 */
export function interfaceHash(program: Program): string {
  return hashText(moduleInterface(program).join('\n'))
}
