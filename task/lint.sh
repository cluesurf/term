#!/usr/bin/env bash
# Lint and format the seed TypeScript in small, visible chunks.
#
# Prettier formats every .ts across the packages (fast, no type information). Eslint --fix then runs ONE DIRECTORY AT A
# TIME so each step finishes in a few seconds and logs its result, instead of one giant invocation that prints nothing
# for minutes and looks hung. A per-chunk timeout means no single directory can stall the whole run. Eslint findings do
# not abort the script, so the formatting always lands.
#
# Run from the seed package root:  bash task/lint.sh   (or  pnpm lint).

set -u
cd "$(dirname "$0")/.." || exit 1

cyan() { printf '\033[36m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m%s\033[0m\n' "$*"; }
yellow() { printf '  \033[33m%s\033[0m\n' "$*"; }

start=$(date +%s)
chunklog=$(mktemp)

count_ts() { find "$1" -name '*.ts' 2>/dev/null | wc -l | tr -d ' '; }

# ---- prettier: format all TypeScript across the packages ----
cyan "== prettier: formatting TypeScript =="
for d in deck/make/code deck/call/code deck/flow/code deck/deck/code \
  deck/base/code deck/face/code deck/site/code test; do
  [ -d "$d" ] || continue
  c=$(count_ts "$d")
  [ "$c" = 0 ] && continue
  printf '  %-24s (%4s files) ... ' "$d" "$c"
  if npx prettier --write "$d/**/*.ts" >/dev/null 2>&1; then
    printf '\033[32mformatted\033[0m\n'
  else
    printf '\033[33mwarn\033[0m\n'
  fi
done
npx prettier --write '*.ts' >/dev/null 2>&1 && echo "  root *.ts             ... formatted"

# ---- eslint --fix: one directory chunk at a time ----
cyan "== eslint --fix: per-directory chunks (type-aware) =="
eslint_chunk() {
  local path="$1"
  local c
  c=$(count_ts "$path")
  [ "$c" = 0 ] && return
  printf '  %-30s (%4s files) ... ' "${path#deck/}" "$c"
  NODE_OPTIONS=--max-old-space-size=8192 timeout 240 \
    npx eslint --fix "$path"/**/*.ts >"$chunklog" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '\033[32mclean\033[0m\n'
  elif [ "$rc" -eq 124 ]; then
    printf '\033[33mTIMEOUT, skipped\033[0m\n'
  else
    local issues
    issues=$(grep -cE '^[[:space:]]+[0-9]+:[0-9]+' "$chunklog" 2>/dev/null || echo '?')
    printf '\033[33mfixed, %s issue(s) remain\033[0m\n' "$issues"
  fi
}

for root in deck/make/code deck/call/code deck/flow/code deck/deck/code test; do
  [ -d "$root" ] || continue
  for sub in "$root"/*/; do
    [ -d "$sub" ] && eslint_chunk "${sub%/}"
  done
  tc=$(find "$root" -maxdepth 1 -name '*.ts' 2>/dev/null | wc -l | tr -d ' ')
  if [ "$tc" != 0 ]; then
    printf '  %-30s (%4s files) ... ' "${root#deck/} (top)" "$tc"
    NODE_OPTIONS=--max-old-space-size=8192 timeout 240 \
      npx eslint --fix "$root"/*.ts >"$chunklog" 2>&1 &&
      printf '\033[32mclean\033[0m\n' || printf '\033[33mfixed\033[0m\n'
  fi
done

rm -f "$chunklog"
end=$(date +%s)
cyan "== lint complete in $((end - start))s =="
