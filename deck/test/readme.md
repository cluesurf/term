# @cluesurf/test

The Seed testing + verification library. The first runnable layers of the verification + synthesis system designed in `note/methodology/verification/`. A package under `deck/` (alongside `make`, `call`, `site`), imported as `@cluesurf/test`. Distinct from the install's `test/` tree, which runs the actual test suites.

Built on the design's governing principle: **one generator** (property testing + the verifier) and **one prover**, with the **search-proposes-checker-verifies** discipline (CEGIS or an AI proposes, the prover checks).

## What runs today

From the seed install root:

- `npx tsx deck/test/code/demo.ts` (8/8) - the closed loop end to end.
- `npx tsx deck/test/code/demo-loop.ts` (7/7) - type-derived generators, bounded proof, and the layered repair loop.
- `npx tsx deck/test/code/demo-contract.ts` (9/9) - refinement-typed contracts, contract verification, and the full spec-to-verified-code loop (including exposing an under-specified contract).

And the verification tests themselves are authored in idiomatic Seed `.tree`, like the other `.tree` suites:

- `npx tsx test/tree/run.ts test/tree/verify.tree` (11/11) - the specs of the synthesized functions (max, min, abs, clamp) at boundary points, in `.tree`.

## The modules

- **`property.ts`** - the property engine. Seeded, deterministic generators (`genWhole`, `genInt`, `genList`, `genTuple`), shrinking, and `check()` returning the **minimal counterexample**. Layer 3, and the verifier half of synthesis.
- **`type.ts`** - `genForType`: derive a generator from a Seed type (`SeedType`) automatically, folding over records, lists, and unions. Any `form` becomes testable with no hand-written generator.
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
