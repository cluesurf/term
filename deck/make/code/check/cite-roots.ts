// The rules a program's roots CITE, transitively. `cite <rule>` under a rule's goal uses another rule (check/holds.ts
// `citedFacts`), but a proof step is not a reference: nothing calls a rule, so the merged build's tree-shaking pruned an
// imported rule that was only cited, and the citation then found no rule to use (2026-10-05). These names are added to
// the roots before the prune, and each kept rule's own citations are followed in turn.

import type { Proof, Program, Statement } from '@term/make/code/compile/node'

// the rule names a body's holds cite, at any depth of its guards and of its proof tree
function citesIn(body: Statement[], into: Set<string>): void {
  const steps = (proof: Proof[] | undefined): void => {
    for (const step of proof ?? []) {
      if (step.head === 'cite' && step.arg) {
        into.add(step.arg)
      }

      steps(step.children)
    }
  }

  for (const statement of body) {
    if (statement.form === 'hold') {
      steps(statement.proof)
    } else if (statement.form === 'if') {
      statement.branches.forEach(branch => citesIn(branch.body, into))

      if (statement.otherwise) {
        citesIn(statement.otherwise, into)
      }
    }
  }
}

// every rule reachable from `roots` by citation, roots excluded
export function citedRules(program: Program, roots: Set<string>): Set<string> {
  const rules = new Map<string, Statement[]>()

  for (const statement of program) {
    if (statement.form === 'function' && (statement.theorem || statement.axiom)) {
      rules.set(statement.name, statement.body)
    }
  }

  const found = new Set<string>()
  const queue = [...roots].filter(name => rules.has(name))

  while (queue.length > 0) {
    const cites = new Set<string>()
    citesIn(rules.get(queue.pop()!) ?? [], cites)

    for (const name of cites) {
      if (rules.has(name) && !roots.has(name) && !found.has(name)) {
        found.add(name)
        queue.push(name)
      }
    }
  }

  return found
}
