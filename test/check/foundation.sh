#!/usr/bin/env bash
#
# foundation.sh -- run the machine-checked foundation battery on the decided kernel (judge.ts) and the refinement
# prover, each test in its own process (the kernel keeps module-level state, so processes must be isolated), and
# tally the total. This is the single command that verifies the foundations-up-to-Vibe-Theory proof layer.
#
#   ./test/check/foundation.sh
#
# Each file states and checks real proof terms / decision-procedure goals; a green total means every one is
# accepted by the sound kernel or discharged by the prover.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

TESTS=(
  foundation          # naturals with induction and arithmetic (companion self-type kernel)
  foundation-judge    # kernel core: universe polymorphism, QTT, equality groupoid, funext, Sigma, self-types
  category-judge      # the category laws (composition associative, identity), via observational funext
  naturals-judge      # self-typed naturals WITH arithmetic: plus and times type-check and compute (1+1=2, 2*2=4)
  naturals2-judge     # self-typed naturals WITH computation on judge.ts (the inductive foundation)
  integers-judge      # the integers as a self-typed inductive on judge.ts (pos / negSucc, eliminator computes)
  integer-arithmetic-judge  # integer negation and successor type-check and compute (neg involution, step across zero)
  integer-addition-judge    # integer addition + signed subtraction compute, all four sign cases (impredicative motive)
  integer-ring-judge        # integer multiplication (4 sign cases) and the decidable order compute: Z is the ordered ring
  succ-judge          # a GENERIC recursive constructor (succ : Nat -> Nat) type-checks and computes, no coercions
  large-elim-judge    # the impredicative bottom universe is sound and bounded (impredicative Pi, predicative above)
  pinch-judge         # the pinch-point keystone, a structural kernel proof (the dimension equals eight)
  keystones-refine    # the floor / ceiling / pinch-point, via the refinement prover (linear arithmetic)
  keystones-arrow     # the arrow of time: integers the unique orderable rung, order lost at the complex numbers
  auto-judge          # ATP: one-step proof search (assumption, refl, modus ponens), sound on the unreachable
  search-judge        # ATP: multi-step forward-chaining search (auto-discovers the pinch-point proof)
  induction-judge     # ATP: proving a universal by induction, auto-discovered by the search
)

total_pass=0
total_fail=0
for t in "${TESTS[@]}"; do
  line="$(npx tsx "test/check/$t.ts" 2>/dev/null | grep -E ': [0-9]+ pass')"
  p="$(printf '%s' "$line" | grep -oE '[0-9]+ pass' | grep -oE '[0-9]+')"
  f="$(printf '%s' "$line" | grep -oE '[0-9]+ fail' | grep -oE '[0-9]+')"
  printf '  %-20s %2s pass, %s fail\n' "$t" "${p:-?}" "${f:-?}"
  total_pass=$((total_pass + ${p:-0}))
  total_fail=$((total_fail + ${f:-0}))
done

echo  "  --------------------------------------------"
printf '  FOUNDATION BATTERY    %s pass, %s fail\n' "$total_pass" "$total_fail"
[ "${total_fail:-1}" -eq 0 ]
