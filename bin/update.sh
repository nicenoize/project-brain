#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

SKILL_PATH="${PROJECT_BRAIN_SKILL_PATH:-skills/project-brain}"

if [ ! -e "$SKILL_PATH" ] && [ -f "SKILL.md" ] && [ -d "scripts" ] && [ -d "bin" ]; then
  SKILL_DIR="$ROOT"
elif [ ! -e "$SKILL_PATH" ]; then
  echo "Project Brain skill path not found: $SKILL_PATH"
  echo "Clone or link the canonical project-brain repo at $SKILL_PATH first."
  exit 1
else
  SKILL_DIR="$(cd "$(dirname "$SKILL_PATH")" && cd "$(basename "$SKILL_PATH")" && pwd -P)"
fi

if ! git -C "$SKILL_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Project Brain skill is not a Git checkout: $SKILL_DIR"
  echo "Use a symlink, submodule, or checkout of the canonical project-brain repo."
  exit 1
fi

dirty="$(git -C "$SKILL_DIR" status --porcelain)"
if [ -n "$dirty" ] && [ "${PROJECT_BRAIN_UPDATE_STASH:-0}" != "1" ]; then
  echo "Project Brain checkout has local changes; refusing to auto-update:"
  git -C "$SKILL_DIR" status --short
  echo ""
  echo "Commit/stash those changes, or set PROJECT_BRAIN_UPDATE_STASH=1 to stash before update."
  exit 1
fi

if [ -n "$dirty" ]; then
  git -C "$SKILL_DIR" stash push -u -m "project-brain auto-update $(date -u +%Y-%m-%dT%H:%M:%SZ)" >/dev/null
fi

upstream="$(git -C "$SKILL_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -n "$upstream" ]; then
  remote="${upstream%%/*}"
  target="$upstream"
  git -C "$SKILL_DIR" fetch "$remote" --prune
else
  branch="${PROJECT_BRAIN_BRANCH:-main}"
  # Default: pull from canonical public repo (not whatever happens to be named "origin").
  # Override URL: PROJECT_BRAIN_UPSTREAM_URL. Override remote name: PROJECT_BRAIN_UPSTREAM_REMOTE.
  # Legacy: set PROJECT_BRAIN_REMOTE (e.g. origin) to fetch/merge from a specific remote by name only.
  if [ -n "${PROJECT_BRAIN_REMOTE:-}" ]; then
    remote="$PROJECT_BRAIN_REMOTE"
  else
    canonical_url="${PROJECT_BRAIN_UPSTREAM_URL:-https://github.com/nicenoize/project-brain.git}"
    remote="${PROJECT_BRAIN_UPSTREAM_REMOTE:-project-brain-upstream}"
    if git -C "$SKILL_DIR" remote get-url "$remote" >/dev/null 2>&1; then
      git -C "$SKILL_DIR" remote set-url "$remote" "$canonical_url"
    else
      git -C "$SKILL_DIR" remote add "$remote" "$canonical_url"
    fi
  fi
  target="$remote/$branch"
  git -C "$SKILL_DIR" fetch "$remote" "$branch" --prune
fi

# The ff-only merge below carries the whole package tree, including the lean
# SKILL.md AND its skills/project-brain/references/*.md detail bundle (#26) — new
# reference files propagate automatically as long as they are committed upstream.
# brain:health reports any reference file that failed to land.
before="$(git -C "$SKILL_DIR" rev-parse --short HEAD)"
git -C "$SKILL_DIR" merge --ff-only "$target"
after="$(git -C "$SKILL_DIR" rev-parse --short HEAD)"

if [ "$before" = "$after" ]; then
  echo "Project Brain already current at $after."
else
  echo "Project Brain updated: $before -> $after."
fi

if command -v node >/dev/null 2>&1 && [ -f "$SKILL_PATH/scripts/setup-package.mjs" ]; then
  node "$SKILL_PATH/scripts/setup-package.mjs"
fi
