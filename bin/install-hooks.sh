#!/usr/bin/env bash
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"
mkdir -p .git/hooks
for hook in skills/project-brain/templates/hooks/*; do
  name="$(basename "$hook")"
  cp "$hook" ".git/hooks/$name"
  chmod +x ".git/hooks/$name"
done
echo "Installed Project Brain Git hooks."
if command -v node >/dev/null 2>&1; then
  if [ -f skills/project-brain/scripts/install-cursor-hooks.mjs ]; then
    node skills/project-brain/scripts/install-cursor-hooks.mjs || true
  elif [ -f scripts/install-cursor-hooks.mjs ]; then
    node scripts/install-cursor-hooks.mjs || true
  fi
fi
