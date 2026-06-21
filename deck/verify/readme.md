# @cluesurf/verify

The Seed verification engine. The first runnable layers of the verification + synthesis system designed in `note/methodology/verification/`.

Built on the design's governing principle: **one generator** (property testing + the verifier), and the **search-proposes-kernel-checks** discipline (here, CEGIS proposes, the verifier checks).

## What runs today

`npx tsx code/demo.ts` proves the closed loop end to end (8/8):

- **`code/property.ts`** - the property-testing engine. Seeded, deterministic generators (`genWhole`, `genInt`, `genList`, `genTuple` - the type-derived derivation), shrinking, and `check()` which returns the **minimal counterexample** when a claim fails. This is Layer 3 of the system and the verifier half of synthesis.
- **`code/synthesize.ts`** - CEGIS (Counterexample-Guided Inductive Synthesis). Given a spec (what correct means) and a grammar of integer expressions, it synthesizes a correct program by letting the verifier's counterexamples carve away the wrong-program space until one converges. This is "the verifier figures out the code," running.
- **`code/demo.ts`** - the proof. Finds the hole in a buggy `max`. Synthesizes `max`, `min`, and `abs` from their specs alone (it derives `abs = max(a, -a)` with no hint). Reports an unsatisfiable spec honestly.

## Where it sits in the plan

This is the runnable foundation. The full system (the build order in `note/methodology/verification/seed-verification-system.md`):

1. SMT bridge + VCG (refinement types, contracts) - **next**, docks Z3.
2. Property testing + generators - **done here**, derive generators from Seed forms next.
3. `test cross` differential across backends.
4. Bounded model checking (reuses the SMT bridge).
5. Symbolic execution + fuzzing (reuse the solver + these generators).

And the synthesis loop (`note/methodology/verification/synthesis.md`):

- Level 1-2 (gap report + mechanical fix) - the `CheckResult` counterexample is the seed of the gap report.
- Level 3 (CEGIS) - **done here** for the integer-expression fragment.
- Level 4 (AI proposer over the same re-verify loop) - plugs into `@cluesurf/link`.

## Next integration steps

- Derive generators automatically from Seed `form`s and primitives (fold over the type), so any Seed type is testable with no hand-written generator.
- Emit a structured `GapReport` from the checker so failures are actionable by the mechanical fixer, CEGIS, or the AI.
- Lift CEGIS from the toy grammar to the Seed IR, and add the SMT backend so the verifier proves (not just samples) the synthesized program.
