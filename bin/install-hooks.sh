#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

HOOKS_DIR="skills/project-brain/templates/hooks"
if [ ! -d "$HOOKS_DIR" ]; then
  echo "ERROR: expected hook templates at $HOOKS_DIR" >&2
  exit 1
fi

# nullglob so an empty templates/hooks/ produces an empty list, not the
# literal pattern.
shopt -s nullglob
hooks=("$HOOKS_DIR"/*)
shopt -u nullglob

if [ "${#hooks[@]}" -eq 0 ]; then
  echo "WARN: no hooks found in $HOOKS_DIR; skipping git-hook install." >&2
else
  mkdir -p .git/hooks
  for hook in "${hooks[@]}"; do
    name="$(basename "$hook")"
    cp "$hook" ".git/hooks/$name"
    chmod +x ".git/hooks/$name"
  done
  echo "Installed Project Brain Git hooks (${#hooks[@]})."
fi

if command -v node >/dev/null 2>&1; then
  if [ -f skills/project-brain/scripts/install-cursor-hooks.mjs ]; then
    node skills/project-brain/scripts/install-cursor-hooks.mjs
  elif [ -f scripts/install-cursor-hooks.mjs ]; then
    node scripts/install-cursor-hooks.mjs
  fi
fi
