// Shared backend machinery. Every code generator must handle every AST form, on every target.
//
// `exhausted` makes that a COMPILE-TIME invariant. Route the `default` branch of any form switch through it: when a
// case is missing, `node` is not narrowed to `never`, so the call fails to typecheck. When a new Expression or
// Statement form is added to the language, every backend that has not added a case stops compiling. So "every
// backend supports everything the language will ever have" is enforced by the type checker, not by hope. If a form
// ever does reach it at runtime (e.g. a hand-built AST), it throws loudly rather than emitting silent wrong code.
export function exhausted(node: never): never {
  throw new Error(
    `backend: unhandled AST form ${JSON.stringify(
      (node as { form?: unknown }).form,
    )}`,
  )
}

// A target that cannot express a form (a GPU shader cannot throw; bare LLVM has no managed map) emits this marker
// instead of silently dropping or miscompiling the construct. The marker is a comment in the target's syntax, so the
// generated source still parses but the gap is visible and greppable (SEED-UNSUPPORTED), never silent.
export function unsupported(
  target: string,
  form: string,
  comment: string,
): string {
  return `${comment} SEED-UNSUPPORTED on ${target}: "${form}" is outside this target's fragment`
}
