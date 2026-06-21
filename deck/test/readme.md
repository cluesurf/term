# @cluesurf/test

The Seed testing + verification library. The first runnable layers of the verification + synthesis system designed in `note/methodology/verification/`. A package under `deck/` (alongside `make`, `call`, `site`), imported as `@cluesurf/test`. Distinct from the install's `test/` tree, which runs the actual test suites.

Built on the design's governing principle: **one generator** (property testing + the verifier) and **one prover**, with the **search-proposes-checker-verifies** discipline (CEGIS or an AI proposes, the prover checks).

## What runs today

From the seed install root:

- `npx tsx deck/test/code/demo.ts` (8/8) - the closed loop end to end.
- `npx tsx deck/test/code/demo-loop.ts` (7/7) - type-derived generators, bounded proof, and the layered repair loop.
- `npx tsx deck/test/code/demo-contract.ts` (9/9) - refinement-typed contracts, contract verification, and the full spec-to-verified-code loop (including exposing an under-specified contract).
- `npx tsx deck/test/code/demo-ir.ts` (6/6) - **live-compiler integration (types in)**: compiles a real `.tree` program, pulls a real `form`'s type out of the compiler IR, derives a generator from it, and property-tests over it. The engine consumes the actual Seed type system.
- `npx tsx deck/test/code/demo-gap.ts` (7/7) - **live-compiler integration (diagnostics out)**: turns the real checker's diagnostics into structured `CheckerGap`s (location, kind, obligation, caret excerpt, hint) - the actionable, AI-readable hole report the synthesis loop consumes.
- `npx tsx deck/test/code/demo-emit.ts` (4/4) - **codegen from verification**: for each contract, synthesize a verified body, emit it as REAL Seed `.tree` source, and COMPILE that source. Spec in -> verified, compilable Seed function out (e.g. it derives and emits `abs = maximum(a, subtract(0, a))`). The full loop closes on real Seed code.
- `npx tsx deck/test/code/demo-pipeline.ts` (4/4) - **the whole loop in one call**, with the AI proposer in place: `autocomplete` takes a contract, tries proposers (the AI plug point first, CEGIS as the net), proves the result, emits Seed, and compiles it. A wrong AI proposal is rejected and CEGIS recovers - the output is always sound.
- `npx tsx deck/test/code/demo-smt.ts` (3/3) - **real UNBOUNDED proof via Z3**: proves the synthesized bodies meet their specs for ALL integers (not just a bound), and refutes a buggy one with a concrete counterexample. Needs `z3-solver` (in package.json; `pnpm install`).
- `npx tsx deck/test/code/demo-synth-smt.ts` (4/4) - **Z3 inside the synthesis loop**: CEGIS where the verifier is Z3, so the synthesized body is proven for ALL integers, then emitted as Seed and compiled. The strongest form of the loop - spec in, unbounded-proven compiling Seed out.
- `npx tsx deck/test/code/demo-cross.ts` (3/3) - **cross-backend differential** (`test cross`): emits the same program to all four backends (TypeScript, Rust, Kotlin, Swift) and checks every backend agrees the program is well-formed. A backend that diverges is a bug. The emitters live in `@cluesurf/make/code/compile/{rust,kotlin,swift}.ts`.
- `npx tsx deck/test/code/demo-fuzz.ts` (4/4) - **coverage-guided fuzzing** (AFL-modeled: edge coverage, corpus evolution, havoc mutators, power schedule, splicing, minimization). Reaches a deep nested bug in 469 execs where blind random fails in the same budget; also finds a property violation. See `note/methodology/verification/fuzzing.md`.
- `npx tsx deck/test/code/demo-hammer.ts` (3/3) - **the proof hammer + terminal workflow**: state a goal, hammer it, get a proof state - PROVED (witness emitted as Seed), REFUTED (counterexample), or OPEN. The core behind the LSP `proof/hammer` and a `seed prove` CLI. See `note/methodology/verification/theorem-proving-lsp.md`.

And the verification tests themselves are authored in idiomatic Seed `.tree`, like the other `.tree` suites:

- `npx tsx test/tree/run.ts test/tree/verify.tree` (11/11) - the specs of the synthesized functions (max, min, abs, clamp) at boundary points, in `.tree`.

## The modules

- **`property.ts`** - the property engine. Seeded, deterministic generators (`genWhole`, `genInt`, `genList`, `genTuple`), shrinking, and `check()` returning the **minimal counterexample**. Layer 3, and the verifier half of synthesis.
- **`type.ts`** - `genForType`: derive a generator from a Seed type (`SeedType`) automatically, folding over records, lists, and unions. Any `form` becomes testable with no hand-written generator.
- **`ir-gen.ts`** - `genFromIR` / `irToSeedType`: the bridge to the live compiler (types in). Translates the compiler's real `Type` IR (from `@cluesurf/make/code/compile/node`) into a generator, resolving `named` record types through the checker's record table. This is what lets property testing run on actual parsed-and-checked Seed types.
- **`checker-gap.ts`** - `gapsFromDiagnostics` / `showGap`: the bridge to the live checker (diagnostics out). Turns each checker diagnostic into a `CheckerGap` - location, kind, obligation message, source excerpt with caret, hint - the structured report Phase A of the synthesis loop emits.
- **`emit.ts`** - `emitSeed`: lower a synthesized expression to real Seed `.tree` source (a compilable `task`). `add`/`subtract` are global calls, `max`/`min` resolve through the math module (it emits the `load`), `ite` lowers to `fork test`. This is the codegen half: verification results become actual Seed code.
- **`smt.ts`** - `makeSmt` / `proveExpr` / `exprToZ3`: the Z3 bridge. Encodes a synthesized expression and a symbolic spec as Z3 formulas and proves the spec holds for ALL integers (unbounded), or returns the counterexample. The one solver the design calls for, docked via `z3-solver`. Replaces the bounded prover with a real decision procedure for the linear-integer fragment.
- **`pipeline.ts`** - `autocomplete`: the whole loop as one call. Contract in -> proposers (AI then CEGIS) -> proof -> emit Seed -> compile against the live compiler -> a sound, compiling result with the record of which proposer answered.
- **`prove.ts`** - `prove`: exhaustive verification over a bounded integer domain. A proof over the bound, not a sample (the "decide up to B" discipline). This is what lets a synthesized program be **proven**, not just sampled.
- **`synthesize.ts`** - CEGIS: an integer-expression grammar, an enumerator, and the counterexample-guided loop. "The verifier figures out the code," running.
- **`gap.ts`** - the synthesis architecture: the `GapReport` (the one interface between "found a hole" and "fill it"), the `Proposer` interface (CEGIS, mechanical fix, and the AI all implement it), and the `repair` driver that tries layered proposers and **proves** each candidate before accepting. A wrong proposal (even a stubborn AI hint) is rejected by proof and the loop falls back to CEGIS.
- **`demo.ts` / `demo-loop.ts`** - the runnable proofs above.

## What it demonstrates

- Finds the hole in a buggy `max` and shrinks it to the minimal `[0,1]`.
- Derives generators from a `{a: int, b: int}` record and a `list of {n: whole}` automatically.
- Proves a true fact over all `|x| <= 8` (289 cases) and finds the exact boundary hole of a false one.
- Synthesizes `max`, `min`, and `abs` from their specs alone (derives `abs = max(a, -a)`).
- Runs the repair loop with layered proposers: an AI-hint proposes, the prover certifies; a **wrong** hint is rejected by proof and CEGIS recovers.

## Where it sits in the plan

The runnable foundation. Build order (`note/methodology/verification/seed-verification-system.md`): generators + property testing (done), bounded proof (done), the gap/proposer/repair loop (done), then the SMT bridge + VCG (dock Z3, for refinement types + contracts), `test cross` differential across the five backends, bounded model checking on the same SMT, and the Level-4 AI proposer wired through `@cluesurf/link`.

Next integration: read the compiler's real type IR in `genForType` (instead of the standalone `SeedType`), emit a `GapReport` from the checker on each unproven obligation, and lift CEGIS from the toy grammar onto the Seed IR with the SMT backend doing the proof.
