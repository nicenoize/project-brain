#!/usr/bin/env bash
# brain:radar — proactive pre-touch / PR briefing hook snippet (OPT-IN).
#
# brain:radar is the file-centric companion to brain:brief: for a target set of
# files it prints, per file, what the brain already knows (active leases,
# governing ADRs, downstream cross-project consumers, open findings, optional
# blast radius). It is read-only, deterministic, and index-only — it never
# mutates state and must NEVER block a Git operation.
#
# This file is a documented, additive snippet — NOT auto-installed, and it does
# not clobber the existing post-checkout / pre-commit hooks. Paste the relevant
# block into the matching hook in .git/hooks/ (or append to the templates here)
# and make it executable. Every invocation soft-exits 0 so a missing index,
# blocked model download, or non-zero radar can never break checkout/commit.
#
# Enable per surface with an env var (both default OFF, matching brain:brief):
#   export BRAIN_RADAR_ON_CHECKOUT=1   # post-checkout: brief the working tree
#   export BRAIN_RADAR_ON_COMMIT=1     # pre-commit:   brief the staged files
#
# --no-impact keeps the hook fast (skips the optional buildImpact blast-radius
# pass); drop it if you want caller/test counts in the hook output too.

set -euo pipefail

# ---------------------------------------------------------------------------
# post-checkout block. Git passes: $1 prev-head, $2 new-head, $3 branch-flag.
# Append inside .git/hooks/post-checkout (after any existing brain commands).
# ---------------------------------------------------------------------------
brain_radar_post_checkout() {
  local previous_head="${1:-}"
  local new_head="${2:-}"
  local branch_checkout="${3:-0}"
  if [ "${BRAIN_RADAR_ON_CHECKOUT:-0}" = "1" ] && [ "$branch_checkout" = "1" ] \
    && [ "$previous_head" != "$new_head" ] && command -v npm >/dev/null 2>&1; then
    npm run brain:radar -- --no-impact || true
  fi
}

# ---------------------------------------------------------------------------
# pre-commit block. No args; targets the staged set. Append inside
# .git/hooks/pre-commit (before the commit is finalized). Advisory only — it
# does NOT abort the commit even on a hard lease conflict.
# ---------------------------------------------------------------------------
brain_radar_pre_commit() {
  if [ "${BRAIN_RADAR_ON_COMMIT:-0}" = "1" ] && command -v npm >/dev/null 2>&1; then
    npm run brain:radar -- --staged --no-impact || true
  fi
}

# If executed directly with a subcommand, dispatch (handy for manual testing):
#   bash brain-radar.sh post-checkout "$@"
#   bash brain-radar.sh pre-commit
case "${1:-}" in
  post-checkout) shift; brain_radar_post_checkout "$@" ;;
  pre-commit)    shift; brain_radar_pre_commit "$@" ;;
  *) : ;; # sourced or no-op; nothing to do
esac
